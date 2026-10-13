import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import argparse
from _fleet import CLI, inventory, output, run_main


def main():
    argparse.ArgumentParser(description="List Fleet machines and live Studio capabilities.").parse_args()
    output(inventory(CLI()))


if __name__ == "__main__":
    run_main(main)
