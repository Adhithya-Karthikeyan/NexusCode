import os
from .models import Account

DEFAULT_LIMIT = 100

def load_account(id):
    return Account(id)

class Service:
    def __init__(self, limit=DEFAULT_LIMIT):
        self.limit = limit

    def run(self):
        return load_account(1)

def _private_helper():
    return os.getpid()
