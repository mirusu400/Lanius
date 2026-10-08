"""Read-only, size-bounded previews of captured HTTP response bodies."""

from __future__ import annotations

import base64
import csv
import io
import json
import re
import zipfile
import zlib
from pathlib import PurePosixPath
from typing import Any
from xml.etree import ElementTree as ET

import brotli
import zstandard

from . import charset
from .content_encoding import content_encoding
from .db.store import FlowRecord

MAX_PREVIEW_BYTES = 20 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 300
MAX_ARCHIVE_TEXT = 16 * 1024
MAX_XML_PART = 12 * 1024 * 1024
MAX_SHEET_ROWS = 100
MAX_SHEET_COLUMNS = 50


class PreviewTooLarge(ValueError):
    pass


def _bounded_zlib(data: bytes, bits: int) -> bytes:
    decoder = zlib.decompressobj(bits)
    result = decoder.decompress(data, MAX_PREVIEW_BYTES + 1)
    if len(result) > MAX_PREVIEW_BYTES or decoder.unconsumed_tail:
        raise PreviewTooLarge
    result += decoder.flush(MAX_PREVIEW_BYTES + 1 - len(result))
    if len(result) > MAX_PREVIEW_BYTES:
        raise PreviewTooLarge
    if not decoder.eof:
        raise ValueError("incomplete compressed response")
    return result


def _decode_preview(data: bytes, encoding: str | None) -> bytes:
    if not encoding:
        return data
    for coding in reversed([part.strip().lower() for part in encoding.split(",") if part.strip()]):
        if coding in {"identity", "none"}:
            continue
        if coding in {"gzip", "x-gzip"}:
            data = _bounded_zlib(data, zlib.MAX_WBITS | 16)
        elif coding in {"deflate", "x-deflate"}:
            try:
                data = _bounded_zlib(data, zlib.MAX_WBITS)
            except zlib.error:
                data = _bounded_zlib(data, -zlib.MAX_WBITS)
        elif coding == "br":
            decoder = brotli.Decompressor()
            pieces = []
            size = 0
            for offset in range(0, len(data), 1024):
                part = decoder.process(data[offset:offset + 1024])
                size += len(part)
                if size > MAX_PREVIEW_BYTES:
                    raise PreviewTooLarge
                pieces.append(part)
            if not decoder.is_finished():
                raise ValueError("incomplete compressed response")
            data = b"".join(pieces)
        elif coding == "zstd":
            with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data)) as stream:
                data = stream.read(MAX_PREVIEW_BYTES + 1)
            if len(data) > MAX_PREVIEW_BYTES:
                raise PreviewTooLarge
        else:
            raise ValueError(f"unsupported content encoding: {coding}")
        if len(data) > MAX_PREVIEW_BYTES:
            raise PreviewTooLarge
    return data

IMAGE_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
    "image/x-icon", "image/vnd.microsoft.icon", "image/avif", "image/svg+xml",
}
TEXT_EXTENSIONS = {
    ".txt", ".md", ".json", ".xml", ".html", ".htm", ".css",
    ".js", ".ts", ".csv", ".log", ".yaml", ".yml", ".svg",
    ".py", ".sh", ".sql",
}
SPREADSHEET_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
}


def _content_type(record: FlowRecord) -> str:
    for name, value in record.response_headers or []:
        if name.lower() == "content-type":
            return value
    return record.response_mime or ""


def _zip_text(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str | None:
    if info.is_dir() or PurePosixPath(info.filename).suffix.lower() not in TEXT_EXTENSIONS:
        return None
    with archive.open(info) as stream:
        sample = stream.read(MAX_ARCHIVE_TEXT + 1)
    if b"\x00" in sample:
        return None
    return sample[:MAX_ARCHIVE_TEXT].decode("utf-8", "replace") + (
        "\n…" if len(sample) > MAX_ARCHIVE_TEXT or info.file_size > MAX_ARCHIVE_TEXT else ""
    )


def _archive_preview(archive: zipfile.ZipFile) -> dict[str, Any]:
    entries = []
    for info in archive.infolist()[:MAX_ARCHIVE_ENTRIES]:
        entries.append({
            "name": info.filename,
            "size": info.file_size,
            "compressed_size": info.compress_size,
            "directory": info.is_dir(),
            "text": _zip_text(archive, info),
        })
    return {
        "kind": "archive",
        "entries": entries,
        "total_entries": len(archive.infolist()),
    }


def _xml_part(archive: zipfile.ZipFile, name: str) -> ET.Element:
    info = archive.getinfo(name)
    if info.file_size > MAX_XML_PART:
        raise ValueError(f"Spreadsheet part is too large to preview: {name}")
    with archive.open(info) as stream:
        data = stream.read(MAX_XML_PART + 1)
    if len(data) > MAX_XML_PART or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError(f"Unsafe or oversized spreadsheet part: {name}")
    return ET.fromstring(data)


def _spreadsheet_preview(archive: zipfile.ZipFile) -> dict[str, Any]:
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    workbook = _xml_part(archive, "xl/workbook.xml")
    relations = _xml_part(archive, "xl/_rels/workbook.xml.rels")
    targets = {
        item.attrib.get("Id"): item.attrib.get("Target", "")
        for item in relations.findall(f"{{{package_ns}}}Relationship")
    }
    shared: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        strings = _xml_part(archive, "xl/sharedStrings.xml")
        for item in strings.findall(f"{{{main}}}si"):
            shared.append("".join(node.text or "" for node in item.iter(f"{{{main}}}t")))

    sheets = []
    all_sheets = workbook.findall(f"{{{main}}}sheets/{{{main}}}sheet")
    for sheet in all_sheets[:20]:
        target = targets.get(sheet.attrib.get(f"{{{rel_ns}}}id"))
        if not target:
            continue
        path = target.lstrip("/") if target.startswith("/") else f"xl/{target}"
        # OOXML relations can contain '../'; zipfile does not normalize paths.
        parts: list[str] = []
        for part in path.split("/"):
            if part == "..":
                if parts:
                    parts.pop()
            elif part and part != ".":
                parts.append(part)
        path = "/".join(parts)
        if path not in archive.namelist():
            continue
        root = _xml_part(archive, path)
        rows = []
        for row in root.findall(f"{{{main}}}sheetData/{{{main}}}row")[:MAX_SHEET_ROWS]:
            cells = []
            for cell in row.findall(f"{{{main}}}c")[:MAX_SHEET_COLUMNS]:
                value = cell.findtext(f"{{{main}}}v")
                cell_type = cell.attrib.get("t")
                if cell_type == "s" and value is not None:
                    try:
                        value = shared[int(value)]
                    except (ValueError, IndexError):
                        pass
                elif cell_type == "inlineStr":
                    inline = cell.find(f"{{{main}}}is")
                    value = "".join(n.text or "" for n in inline.iter(f"{{{main}}}t")) if inline is not None else ""
                elif cell_type == "b" and value is not None:
                    value = "TRUE" if value == "1" else "FALSE"
                cells.append({"ref": cell.attrib.get("r", ""), "value": value or ""})
            rows.append({"number": row.attrib.get("r", ""), "cells": cells})
        sheets.append({"name": sheet.attrib.get("name", "Sheet"), "rows": rows})
    return {"kind": "spreadsheet", "sheets": sheets, "total_sheets": len(all_sheets)}


def _csv_preview(body: bytes, content_type: str) -> dict[str, Any]:
    decoded = charset.decode_body(content_type, body)
    try:
        rows = list(csv.reader(io.StringIO(decoded[:500_000])))[:MAX_SHEET_ROWS]
    except csv.Error:
        return {"kind": "text", "text": decoded}
    return {"kind": "csv", "rows": [row[:MAX_SHEET_COLUMNS] for row in rows]}


def response_preview(record: FlowRecord) -> dict[str, Any]:
    """Return a preview model, never executable captured content."""
    if record.response_body_omitted:
        return {"kind": "unavailable", "reason": "media_body_omitted"}
    if record.type != "http" or record.response_body is None:
        return {"kind": "unavailable", "reason": "no_response"}
    raw = record.response_body
    encoding = content_encoding(record.response_headers)
    try:
        body = _decode_preview(raw, encoding)
    except PreviewTooLarge:
        return {"kind": "unavailable", "reason": "too_large"}
    except (TypeError, ValueError, zlib.error, brotli.error, zstandard.ZstdError):
        return {"kind": "unavailable", "reason": "decode_failed"}
    if body is None or not body:
        return {"kind": "unavailable", "reason": "empty"}
    if len(body) > MAX_PREVIEW_BYTES:
        return {"kind": "unavailable", "reason": "too_large"}

    content_type = _content_type(record)
    mime = content_type.split(";", 1)[0].strip().lower()
    suffix = PurePosixPath((record.path or "").lower()).suffix
    partial = record.response_size > len(raw)
    if body.startswith(b"%PDF-") or mime == "application/pdf" or suffix == ".pdf":
        if partial:
            return {"kind": "unavailable", "reason": "truncated"}
        return {"kind": "pdf", "data": base64.b64encode(body).decode("ascii")}

    if body.startswith(b"PK\x03\x04") or mime in SPREADSHEET_TYPES or mime == "application/zip" or suffix in {".zip", ".xlsx", ".xlsm"}:
        if partial:
            return {"kind": "unavailable", "reason": "truncated"}
        try:
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                if "xl/workbook.xml" in archive.namelist():
                    return _spreadsheet_preview(archive)
                return _archive_preview(archive)
        except (OSError, ValueError, KeyError, ET.ParseError, zipfile.BadZipFile, RuntimeError):
            return {"kind": "unavailable", "reason": "invalid_archive"}

    svg_document = re.match(rb"\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg(?:\s|>)", body[:1024], re.I)
    if mime == "image/svg+xml" or suffix == ".svg" or svg_document:
        return {"kind": "image", "mime": "image/svg+xml", "data": base64.b64encode(body).decode("ascii")}
    signatures = (
        (b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"),
        (b"GIF8", "image/gif"), (b"BM", "image/bmp"),
        (b"\x00\x00\x01\x00", "image/x-icon"),
    )
    image_mime = next((kind for signature, kind in signatures if body.startswith(signature)), None)
    if body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        image_mime = "image/webp"
    if image_mime or mime in IMAGE_TYPES:
        return {"kind": "image", "mime": image_mime or mime, "data": base64.b64encode(body).decode("ascii")}

    text = charset.decode_body(content_type, body)
    if mime in {"text/html", "application/xhtml+xml"} or suffix in {".html", ".htm"} or re.match(r"\s*(?:<!doctype html|<html[\s>])", text[:200], re.I):
        return {"kind": "html", "text": text}
    if mime in {"text/csv", "application/csv"} or suffix == ".csv":
        return _csv_preview(body, content_type)
    if mime == "application/json" or mime.endswith("+json") or suffix == ".json":
        try:
            text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
        except ValueError:
            pass
        return {"kind": "text", "text": text}
    if mime.startswith("text/") or mime in {"application/xml", "application/javascript"} or mime.endswith("+xml"):
        return {"kind": "text", "text": text}
    return {"kind": "unavailable", "reason": "unsupported"}
