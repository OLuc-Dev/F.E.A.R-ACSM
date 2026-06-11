from __future__ import annotations

import argparse

from fear.library.reference_library import ReferenceLibrary


def main() -> None:
    """Index a folder of local markdown summaries into the reference library."""
    parser = argparse.ArgumentParser(description="Index local markdown notes for F.E.A.R.")
    parser.add_argument("folder", help="Folder containing markdown files")
    parser.add_argument("--source", default="local_notes", help="Source label stored in metadata")
    parser.add_argument("--chroma-path", default="data/chroma", help="ChromaDB persistent path")
    parser.add_argument("--collection", default="book_knowledge", help="ChromaDB collection name")
    args = parser.parse_args()

    library = ReferenceLibrary(
        path=args.chroma_path,
        collection_name=args.collection,
    )
    count = library.index_folder(args.folder, source=args.source)
    print(f"Indexed {count} chunks from {args.folder} into {args.collection}.")


if __name__ == "__main__":
    main()
