"""Convenience entry point used by the web build and CI."""
import sys

from pipeline import build


if __name__ == "__main__":
    try:
        build()
    except Exception as error:
        print("ERROR: " + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
