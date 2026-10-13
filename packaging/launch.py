"""PyInstaller entry point for the F.E.A.R. Windows app (see fear/desktop.py)."""

import multiprocessing

from fear.desktop import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
