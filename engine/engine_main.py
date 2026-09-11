"""Frozen-binary entrypoint.

PyInstaller runs its entry script as ``__main__`` without a package context,
so ``app/main.py``'s relative imports would fail. Import the package properly
and delegate.
"""

from app.main import main

if __name__ == "__main__":
    main()
