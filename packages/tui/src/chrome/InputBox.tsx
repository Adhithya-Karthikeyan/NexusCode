/**
 * `<InputBox>` (design spec §2.4, §6.2, §6.7) — the multiline composer. It owns
 * the *only* TUI-local state (the input draft) and turns keypresses into intents:
 * a **deliberate** submit (Enter sends; Alt+Enter / trailing `\` / open fence →
 * newline), a bracketed-paste guard so a paste never fires a turn, `↑/↓` history
 * at the buffer edges, readline editing, and the `Esc` / `Esc Esc` interrupt
 * ladder wired to an injected `onInterrupt`. Refuses raw mode when unsupported
 * (headless), so it renders without crashing on a non-TTY.
 */

import { Box, Text, useInput, useStdin } from "ink";
import { useEffect, useRef, useState } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import {
  atFirstLine,
  atLastLine,
  backspace,
  deleteWordLeft,
  emptyBuffer,
  fromText,
  hasOpenFence,
  insert,
  insertMultiline,
  isEmpty,
  isSingleLine,
  killToLineEnd,
  killToLineStart,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  newline,
  toText,
  type Buffer,
} from "../input/buffer.js";
import { createHistory, newer, older, push, type History } from "../input/history.js";
import { classifyInput, initialPasteState, looksLikePaste, type PasteState } from "../input/paste.js";
import { classifyEsc, type InterruptMode } from "../interrupt/interrupt.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

export interface InputBoxProps {
  /** Fired on a deliberate submit with the composed text. */
  onSubmit?: (text: string) => void;
  /** Fired on Esc (graceful) / Esc Esc (hard) — wired to the engine abort. */
  onInterrupt?: (mode: InterruptMode) => void;
  /** Prompt caret prefix; defaults to the brand `◆ ▸`. */
  promptLabel?: string;
  /** Seed history (e.g. restored from disk). */
  history?: readonly string[];
  /** Disable input capture (used when an overlay owns keys). */
  isActive?: boolean;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /**
   * Reports composing state up to the keymap owner (§6.1). `false` when the draft
   * is empty, `true` once it holds content. An outer scope (panel traversal /
   * compare-lane jump) consumes `Tab`/`1`–`4` only while this is `false`, so the
   * composer and workspace never both act on one keystroke (§2.7, §6.4).
   */
  onComposingChange?: (composing: boolean) => void;
  /**
   * Reports the full draft text up to a parent (e.g. the conversation shell's
   * slash-command autocomplete). Fired on every buffer change via an effect, so
   * the parent stays a pure observer and the composer keeps owning the draft.
   */
  onDraftChange?: (text: string) => void;
  /**
   * When set, `1`–`4` are reserved by an outer scope while the draft is empty
   * (compare-lane jump, §2.9.3) — the composer swallows them instead of inserting,
   * so exactly one scope consumes the digit. Layout-agnostic from here: the
   * composer only knows "these keys are reserved when empty".
   */
  reserveDigitsWhenEmpty?: boolean;
  /**
   * Lets an overlay (the slash-command menu) borrow navigation keys while it is
   * open. The composer calls this for `↑`/`↓` (up/down), `Enter` (select), `Tab`
   * (complete) and `Esc` (cancel); if it returns `true` the composer treats the
   * key as consumed and skips its own default (history walk / submit / interrupt).
   * Absent → the composer behaves exactly as before (backward compatible).
   */
  onNavigate?: (action: "up" | "down" | "select" | "complete" | "cancel") => boolean;
  /**
   * External buffer reset. When `seq` changes the composer replaces its draft with
   * `text` (used to clear the input after a command runs, or Tab-complete a command
   * name). Never fires on mount (only on a change of `seq`).
   */
  resetTo?: { seq: number; text: string };
}

export function InputBox({
  onSubmit,
  onInterrupt,
  promptLabel,
  history: seedHistory,
  isActive = true,
  now = Date.now,
  onComposingChange,
  onDraftChange,
  reserveDigitsWhenEmpty = false,
  onNavigate,
  resetTo,
}: InputBoxProps): React.JSX.Element {
  const caps = useCaps();
  const { isRawModeSupported } = useStdin();
  const [buffer, setBuffer] = useState<Buffer>(emptyBuffer);
  const [history, setHistory] = useState<History>(() => createHistory(500, seedHistory ?? []));
  const pasteRef = useRef<PasteState>(initialPasteState);
  const escTsRef = useRef<number>(0);
  // External buffer reset (slash-command clear / Tab-complete). Track the last
  // applied `seq` so it fires only on a change, never on mount.
  const lastResetSeq = useRef<number | undefined>(resetTo?.seq);
  useEffect(() => {
    if (resetTo === undefined) return;
    if (resetTo.seq === lastResetSeq.current) return;
    lastResetSeq.current = resetTo.seq;
    setBuffer(fromText(resetTo.text));
    pasteRef.current = initialPasteState;
  }, [resetTo]);

  // Surface composing state to the keymap owner (§6.1). An effect (never a
  // render-time parent setState) so `Tab`/`1`–`4` scope-arbitration upstream
  // sees the settled emptiness of the *previous* keystroke — which is exactly
  // when the emptiness can differ, since only insert/delete toggles it.
  const composing = !isEmpty(buffer);
  useEffect(() => {
    onComposingChange?.(composing);
  }, [composing, onComposingChange]);

  // Surface the full draft text (slash-command autocomplete, §6). Pure observer:
  // the parent never owns the buffer, it only reacts to what the composer holds.
  const draftText = toText(buffer);
  useEffect(() => {
    onDraftChange?.(draftText);
  }, [draftText, onDraftChange]);

  const promptStyle = useTextStyle("accent.default");
  const textStyle = useTextStyle("stream.text");
  const mutedStyle = useTextStyle("text.muted");
  const fenceStyle = useTextStyle("warning.fg");

  const submit = (): void => {
    const text = toText(buffer);
    if (text.trim() === "") return;
    onSubmit?.(text);
    setHistory((h) => push(h, text));
    setBuffer(emptyBuffer);
    pasteRef.current = initialPasteState;
  };

  useInput(
    (input, key) => {
      const t = now();

      // --- Paste guard (law #1): a multi-line / burst chunk is content, never submit.
      if (looksLikePaste(input)) {
        const verdict = classifyInput(pasteRef.current, input, t);
        pasteRef.current = verdict.next;
        setBuffer((b) => insertMultiline(b, input));
        return;
      }
      const verdict = classifyInput(pasteRef.current, input, t);
      pasteRef.current = verdict.next;

      // --- Overlay navigation (slash-command menu). When an overlay claims the
      // key it is fully consumed here, before the composer's own default.
      if (key.tab) {
        onNavigate?.("complete");
        return;
      }

      // --- Interrupt ladder (Esc first offers to close an open overlay).
      if (key.escape) {
        if (onNavigate?.("cancel")) return;
        const { mode, nextEscTs } = classifyEsc(escTsRef.current, t);
        escTsRef.current = nextEscTs;
        onInterrupt?.(mode);
        return;
      }
      if (key.ctrl && input === "c") {
        onInterrupt?.("graceful");
        return;
      }

      // --- Submit vs newline (§6.2 enter-sends default). An open menu takes Enter
      // as "run the highlighted command" instead of submitting the draft.
      if (key.return) {
        if (onNavigate?.("select")) return;
        const line = buffer.lines[buffer.row] ?? "";
        if (key.meta) {
          setBuffer((b) => newline(b));
        } else if (line.endsWith("\\")) {
          setBuffer((b) => newline(backspaceAtEnd(b)));
        } else if (hasOpenFence(buffer)) {
          setBuffer((b) => newline(b));
        } else {
          submit();
        }
        return;
      }

      // --- Readline editing.
      if (key.ctrl) {
        switch (input) {
          case "a":
            setBuffer(moveLineStart);
            return;
          case "e":
            setBuffer(moveLineEnd);
            return;
          case "w":
            setBuffer(deleteWordLeft);
            return;
          case "u":
            setBuffer(killToLineStart);
            return;
          case "k":
            setBuffer(killToLineEnd);
            return;
          default:
            return;
        }
      }

      if (key.backspace || key.delete) {
        setBuffer(backspace);
        return;
      }
      if (key.leftArrow) {
        setBuffer(moveLeft);
        return;
      }
      if (key.rightArrow) {
        setBuffer(moveRight);
        return;
      }
      if (key.upArrow) {
        if (onNavigate?.("up")) return;
        if (atFirstLine(buffer)) {
          const walk = older(history, toText(buffer));
          if (walk) {
            setHistory(walk.history);
            setBuffer(fromText(walk.value));
          }
        } else {
          setBuffer(moveUp);
        }
        return;
      }
      if (key.downArrow) {
        if (onNavigate?.("down")) return;
        if (atLastLine(buffer) && history.index !== -1) {
          const walk = newer(history);
          if (walk) {
            setHistory(walk.history);
            setBuffer(fromText(walk.value));
          }
        } else {
          setBuffer(moveDown);
        }
        return;
      }

      // --- Printable char.
      if (input && input >= " ") {
        // While empty, `1`–`4` belong to the outer compare-lane scope (§2.9.3);
        // swallow them here so the workspace's jump isn't shadowed by an insert.
        if (reserveDigitsWhenEmpty && isEmpty(buffer) && /^[1-4]$/.test(input)) return;
        setBuffer((b) => insert(b, input));
      }
    },
    // `=== true`: on a non-TTY Ink reports `undefined` for raw-mode support and
    // treats an `undefined` `isActive` as active — the strict compare keeps this
    // composer inert (headless / forced-mount) instead of throwing on raw mode.
    { isActive: isActive && isRawModeSupported === true },
  );

  const prompt = promptLabel ?? `${glyph(caps, "node")} ${glyph(caps, "prompt")}`;
  const openFence = hasOpenFence(buffer);
  const placeholder = "type a message…";

  return (
    <Box flexDirection="column">
      {buffer.lines.map((line, i) => (
        <Box key={i}>
          {i === 0 ? <Text {...(openFence ? fenceStyle : promptStyle)}>{prompt} </Text> : <Text>{"  "}</Text>}
          {isEmpty(buffer) && i === 0 ? (
            <Text {...mutedStyle}>{placeholder}</Text>
          ) : (
            <Text {...textStyle}>
              {line}
              {i === buffer.row ? <Text {...promptStyle}>{caps.unicode ? "▍" : "|"}</Text> : null}
            </Text>
          )}
        </Box>
      ))}
      {!isSingleLine(buffer) ? (
        <Text {...mutedStyle}>
          {buffer.lines.length} lines · {glyph(caps, "node")} Alt+Enter newline · Enter send
        </Text>
      ) : null}
    </Box>
  );
}

/** Drop the trailing `\` before inserting a newline (the `\`+Enter form, §6.2). */
function backspaceAtEnd(b: Buffer): Buffer {
  const line = b.lines[b.row] ?? "";
  if (!line.endsWith("\\")) return b;
  const lines = b.lines.slice();
  lines[b.row] = line.slice(0, -1);
  return { lines, row: b.row, col: Math.min(b.col, lines[b.row]!.length) };
}
