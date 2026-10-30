"""Classify disk-accounting failures at the check that rejects a reading."""


class AccountingError(Exception):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason
