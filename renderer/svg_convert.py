from __future__ import annotations

import argparse
import base64
import io
import json
import sys


def _read_payload() -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload-file", required=True)
    args = parser.parse_args()
    with open(args.payload_file, "r", encoding="utf-8") as fh:
        return json.load(fh)


def convert_svg(svg: str, fmt: str, dpi: int) -> bytes:
    fmt = fmt.lower()
    if fmt == "svg":
        return svg.encode("utf-8")

    try:
        import cairosvg
    except OSError as exc:  # pragma: no cover - depends on local env
        raise RuntimeError("缺少 Cairo 运行库，无法导出 PDF/PNG/TIFF") from exc
    except Exception as exc:  # pragma: no cover - depends on local env
        raise RuntimeError("缺少 cairosvg，无法导出 PDF/PNG/TIFF") from exc

    if fmt == "pdf":
        return cairosvg.svg2pdf(bytestring=svg.encode("utf-8"), dpi=dpi)
    if fmt == "png":
        return cairosvg.svg2png(bytestring=svg.encode("utf-8"), dpi=dpi)
    if fmt in {"tif", "tiff"}:
        try:
            from PIL import Image
        except Exception as exc:  # pragma: no cover - depends on local env
            raise RuntimeError("缺少 Pillow，无法导出 TIFF") from exc
        png_bytes = cairosvg.svg2png(bytestring=svg.encode("utf-8"), dpi=dpi)
        image = Image.open(io.BytesIO(png_bytes))
        out = io.BytesIO()
        image.save(out, format="TIFF", dpi=(dpi, dpi))
        return out.getvalue()
    raise ValueError(f"不支持的组合图导出格式: {fmt}")


def main() -> None:
    try:
        payload = _read_payload()
        svg = payload.get("svg") or ""
        fmt = str(payload.get("format") or "svg").lower()
        dpi = int(payload.get("dpi") or 300)
        data = convert_svg(svg, fmt, dpi)
        print(json.dumps({
            "status": "success",
            "format": "tiff" if fmt == "tif" else fmt,
            "binary_b64": base64.b64encode(data).decode("ascii") if fmt != "svg" else None,
            "svg": svg if fmt == "svg" else None,
        }))
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))


if __name__ == "__main__":
    main()
