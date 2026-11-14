#!/usr/bin/env python3
import argparse
import base64
import datetime as dt
import gzip
import hashlib
import json
import pathlib
import re
import sys

ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\"}
ESCAPE_RE = re.compile(r"\\(.)")
ID_RE = re.compile(r"^v([1-9]\d{0,9})$")
CHAR_RE = re.compile(r"^c[1-9]\d{0,9}$")

def unescape(value):
    if value == r"\N":
        return None
    return ESCAPE_RE.sub(lambda m: ESCAPES.get(m.group(1), m.group(1)), value)

def table_dir(root):
    for candidate in (root / "db", root):
        if (candidate / "chars.header").is_file():
            return candidate
    raise FileNotFoundError("Official dump extraction has no chars.header")

def headers(folder, name):
    path = folder / (name + ".header")
    if not path.is_file():
        raise FileNotFoundError("Missing VNDB dump table header: " + str(path))
    return path.read_text(encoding="utf-8").strip().split("\t")

def rows(folder, name, expected):
    header = headers(folder, name)
    index = {column: i for i, column in enumerate(header)}
    missing = [column for column in expected if column not in index]
    if missing:
        raise ValueError(name + " table is missing required columns " + repr(missing) + "; actual=" + repr(header))
    file = folder / name
    if not file.is_file():
        raise FileNotFoundError("Missing VNDB dump table: " + str(file))
    with file.open("r", encoding="utf-8", newline="") as stream:
        for line_number, line in enumerate(stream, 1):
            values = line.rstrip("\n").rstrip("\r").split("\t")
            if len(values) != len(header):
                raise ValueError(f"{name}:{line_number} has {len(values)} fields, expected {len(header)}")
            yield {column: unescape(values[index[column]]) for column in expected}

def load_ids(bitmap_file):
    encoded = bitmap_file.read_text(encoding="ascii").strip()
    bitmap = gzip.decompress(base64.b64decode(encoded, validate=True))
    max_id = 69757
    if len(bitmap) != (max_id + 8) // 8:
        raise ValueError("VNDB source ID bitset has unexpected length")
    ids = ["v" + str(value) for value in range(1, max_id + 1) if bitmap[value >> 3] & (1 << (value & 7))]
    if len(ids) != 7200 or ids[0] != "v2" or ids[-1] != "v69757":
        raise ValueError("VNDB exact source ID set failed count/min/max validation: " + repr((len(ids), ids[:1], ids[-1:])))
    return ids, hashlib.sha256(bitmap_file.read_bytes()).hexdigest()

def parse_int(value):
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None

def cdn_image(image_id):
    match = re.fullmatch(r"ch([1-9]\d{0,9})", str(image_id or ""))
    if not match:
        return None
    number = int(match.group(1))
    return "https://t.vndb.org/ch/" + str(number % 100).zfill(2) + "/" + str(number) + ".jpg"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump-root", required=True, type=pathlib.Path)
    parser.add_argument("--bitmap", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    args = parser.parse_args()

    ids, bitmap_hash = load_ids(args.bitmap)
    wanted = set(ids)
    folder = table_dir(args.dump_root)
    timestamp_path = args.dump_root / "TIMESTAMP"
    if not timestamp_path.exists():
        timestamp_path = folder / "TIMESTAMP"
    dump_timestamp = timestamp_path.read_text(encoding="utf-8").strip() if timestamp_path.exists() else None
    match = re.search(r"\d{4}-\d{2}-\d{2}", dump_timestamp or "")
    dump_date = match.group(0) if match else None

    appearance_by_character = {}
    work_counts = {vndb_id: 0 for vndb_id in ids}
    relation_rows = 0
    for row in rows(folder, "chars_vns", ["id", "vid", "role", "spoil"]):
        char_id = row["id"]
        work_id = row["vid"]
        if not char_id or not CHAR_RE.fullmatch(char_id) or work_id not in wanted:
            continue
        role = str(row["role"] or "appears").lower()
        if role not in {"main", "primary", "side", "appears"}:
            role = "appears"
        spoiler = parse_int(row["spoil"])
        if spoiler is not None and spoiler < 0:
            spoiler = None
        item = {"vndbId": work_id, "role": role, "spoiler": spoiler}
        values = appearance_by_character.setdefault(char_id, [])
        if item not in values:
            values.append(item)
            work_counts[work_id] += 1
        relation_rows += 1

    if not appearance_by_character:
        raise ValueError("Official dump returned no character appearances for the exact 7,200 VNDB IDs")

    character_rows = {}
    needed_image_ids = set()
    for row in rows(folder, "chars", ["id", "name", "original", "alias", "image"]):
        char_id = row["id"]
        if char_id not in appearance_by_character:
            continue
        name = str(row["name"] or "").strip()
        if not name:
            continue
        aliases = [part.strip() for part in str(row["alias"] or "").split("\n") if part.strip()]
        image_id = row["image"]
        image_id = image_id if image_id and image_id != r"\N" else None
        if image_id:
            needed_image_ids.add(image_id)
        character_rows[char_id] = {
            "id": char_id,
            "vndbCharacterId": char_id,
            "name": name,
            "original": row["original"],
            "aliases": sorted(set(aliases)),
            "imageId": image_id,
            "imageUrl": None,
            "appearances": sorted(appearance_by_character[char_id],
                key=lambda a: (a["vndbId"], a["role"], -1 if a["spoiler"] is None else a["spoiler"]))
        }

    if not character_rows:
        raise ValueError("Official chars table did not contain any names for returned character appearances")

    available_images = set()
    for row in rows(folder, "images", ["id"]):
        if row["id"] in needed_image_ids:
            available_images.add(row["id"])
    for character in character_rows.values():
        if character["imageId"] in available_images:
            character["imageUrl"] = cdn_image(character["imageId"])
        del character["imageId"]

    characters = sorted(character_rows.values(), key=lambda item: item["vndbCharacterId"])
    work_rows = [{"vndbId": vndb_id, "characterCount": work_counts[vndb_id]} for vndb_id in ids]
    works_with = sum(1 for value in work_counts.values() if value)
    total_appearances = sum(work_counts.values())
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    result = {
        "schemaVersion": 1,
        "source": "VNDB Official Public Database Dump",
        "sourceUrl": "https://vndb.org/d14",
        "sourceLicense": "ODbL",
        "retrievedAt": now,
        "dumpDate": dump_date,
        "dumpTimestamp": dump_timestamp,
        "bitmapSha256": bitmap_hash,
        "queriedVndbWorks": len(ids),
        "requestCount": 0,
        "pageCount": 0,
        "counts": {
            "characters": len(characters),
            "uniqueAppearances": total_appearances,
            "worksWithCharacters": works_with,
            "worksWithoutCharacters": len(ids) - works_with,
            "charactersWithImage": sum(1 for character in characters if character["imageUrl"]),
            "charactersWithoutImage": sum(1 for character in characters if not character["imageUrl"]),
            "appearanceRowsRead": relation_rows
        },
        "vndbWorkIds": ids,
        "characters": characters,
        "works": work_rows
    }
    args.out.mkdir(parents=True, exist_ok=True)
    output = args.out / "vndb-character-raw-export.json"
    temp = output.with_suffix(".json.tmp")
    temp.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(output)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    summary = {key: result[key] for key in ("source", "sourceUrl", "sourceLicense", "retrievedAt", "dumpDate", "dumpTimestamp", "queriedVndbWorks", "requestCount", "pageCount", "counts", "bitmapSha256")}
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.out / "sha256.txt").write_text(digest + "  vndb-character-raw-export.json\n", encoding="ascii")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(type(exc).__name__ + ": " + str(exc), file=sys.stderr)
        raise
