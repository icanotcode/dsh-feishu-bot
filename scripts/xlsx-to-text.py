#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""xlsx -> 纯文本（TSV）提取器，仅用 Python 标准库。

xlsx 本质是 zip 包：sharedStrings.xml 存字符串表，worksheets/sheetN.xml 存单元格。
数值日期会以序列号原样输出（不做格式推断）。
用法: python3 xlsx-to-text.py <文件.xlsx>   输出到 stdout(UTF-8)，错误写 stderr 并退出 1。
"""

import sys
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
MAX_ROWS_PER_SHEET = 1000


def text_of(elem):
    return "".join(elem.itertext()) if elem is not None else ""


def load_shared_strings(zf):
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [text_of(si) for si in root.findall(f"{NS}si")]


def sheet_paths(zf):
    """workbook.xml + rels -> [(工作表名, 包内路径)]"""
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    targets = {}
    for rel in rels:
        rid, target = rel.get("Id"), rel.get("Target", "")
        if target:
            targets[rid] = "xl/" + target.lstrip("/") if not target.startswith("xl/") else target
    out = []
    for sheet in wb.iter(f"{NS}sheet"):
        rid = sheet.get(f"{NS_R}id")
        path = targets.get(rid)
        if path:
            out.append((sheet.get("name", "未命名"), path))
    return out


def cell_text(cell, shared):
    kind = cell.get("t")
    if kind == "inlineStr":
        return text_of(cell.find(f"{NS}is"))
    value = cell.find(f"{NS}v")
    if value is None or value.text is None:
        return ""
    if kind == "s":
        try:
            return shared[int(value.text)]
        except (ValueError, IndexError):
            return ""
    return value.text


def main():
    if len(sys.argv) != 2:
        sys.exit("用法: xlsx-to-text.py <文件.xlsx>")
    try:
        zf = zipfile.ZipFile(sys.argv[1])
    except (zipfile.BadZipFile, OSError) as e:
        sys.exit(f"不是有效的 xlsx 文件: {e}")
    with zf:
        shared = load_shared_strings(zf)
        sheets = sheet_paths(zf)
        if not sheets:
            sys.exit("xlsx 中未找到工作表")
        chunks = []
        for name, path in sheets:
            try:
                root = ET.fromstring(zf.read(path))
            except KeyError:
                continue
            rows = []
            for row in root.iter(f"{NS}row"):
                cells = [cell_text(c, shared) for c in row.findall(f"{NS}c")]
                rows.append("\t".join(cells).rstrip("\t"))
                if len(rows) >= MAX_ROWS_PER_SHEET:
                    rows.append(f"…（仅前 {MAX_ROWS_PER_SHEET} 行）")
                    break
            chunks.append(f"== 工作表「{name}」 ==\n" + "\n".join(rows))
        sys.stdout.write("\n\n".join(chunks) + "\n")


if __name__ == "__main__":
    main()
