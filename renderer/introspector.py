"""
IFC v2 Introspector + Replay Engine
=====================================
Deterministic artist-tree introspection for matplotlib Figure objects.

Usage:
    from introspector import introspect_figure, replay_render

    fig = ...  # any matplotlib Figure
    result = introspect_figure(fig)
    # result.svg  -> SVG string with id attributes on recognised elements
    # result.manifest -> JSON-serialisable manifest dict
"""

import io
import json
import re
import traceback
from typing import Any, Optional
from contextlib import contextmanager

import matplotlib
import matplotlib.colors as mcolors
matplotlib.use("Agg")


_figure_registry = []

def _register_figure(fig):
    if fig not in _figure_registry:
        _figure_registry.append(fig)

# Monkey patch Figure.__init__ to record all created figures
from matplotlib.figure import Figure
original_fig_init = Figure.__init__

def patched_fig_init(self, *args, **kwargs):
    original_fig_init(self, *args, **kwargs)
    _register_figure(self)

Figure.__init__ = patched_fig_init


def _describe_uploaded_data(data: Optional[dict]) -> dict:
    rows = data.get("custom_data", []) if data else []
    first_row = rows[0] if rows and isinstance(rows[0], dict) else {}
    columns = list(first_row.keys()) if isinstance(first_row, dict) else []
    return {
        "rowCount": len(rows),
        "columns": columns,
    }


def _build_script_error_message(exc: Exception, data: Optional[dict]) -> str:
    dataset_info = _describe_uploaded_data(data)
    base = f"脚本执行失败: {exc}"

    if isinstance(exc, KeyError):
        missing = exc.args[0] if exc.args else "<unknown>"
        available = ", ".join(dataset_info["columns"]) if dataset_info["columns"] else "无可识别列"
        return (
            f"{base}\n"
            f"缺失列: {missing}\n"
            f"当前上传数据列: {available}\n"
            f"当前行数: {dataset_info['rowCount']}"
        )

    return base


@contextmanager
def _guard_user_script_io(cwd: Optional[str] = None, uploaded_file_paths: Optional[dict] = None, original_cwd: Optional[str] = None):
    import os
    import pandas as pd
    import matplotlib.pyplot as plt
    from matplotlib.figure import Figure

    original_show = plt.show
    original_savefig = plt.savefig
    original_fig_savefig = Figure.savefig
    original_read_csv = getattr(pd, "read_csv", None)
    original_read_excel = getattr(pd, "read_excel", None)

    def _resolve_mapped_path(filepath_or_buffer):
        if not isinstance(filepath_or_buffer, str):
            return filepath_or_buffer
        if not uploaded_file_paths:
            return filepath_or_buffer
            
        lookup_key = filepath_or_buffer
        if lookup_key.startswith("./"):
            lookup_key = lookup_key[2:]
        elif lookup_key.startswith(".\\"):
            lookup_key = lookup_key[2:]
            
        base_key = os.path.basename(filepath_or_buffer)
        ext = os.path.splitext(base_key)[1]
        base_without_ext = os.path.splitext(base_key)[0]
        
        mapped = None
        if lookup_key in uploaded_file_paths:
            mapped = uploaded_file_paths[lookup_key]
        elif base_key in uploaded_file_paths:
            mapped = uploaded_file_paths[base_key]
        elif base_without_ext in uploaded_file_paths:
            mapped = uploaded_file_paths[base_without_ext]
            
        if mapped:
            if not os.path.isabs(mapped) and original_cwd:
                return os.path.abspath(os.path.join(original_cwd, mapped))
            return os.path.abspath(mapped)
        return filepath_or_buffer

    def _blocked_show(*args, **kwargs):
        return None

    def _blocked_savefig(*args, **kwargs):
        raise RuntimeError("请不要在自定义脚本中调用 savefig；平台会自动接管导出。")

    def _is_path_inside(child: str, parent: str) -> bool:
        child = os.path.realpath(child)
        parent = os.path.realpath(parent)
        return os.path.commonpath([child, parent]) == parent

    def _sandboxed_read_csv(filepath_or_buffer, *args, **kwargs):
        if not cwd:
            raise RuntimeError("请不要在自定义脚本中直接读取本地文件；请通过上传数据并使用 _uploaded_data。")
        resolved_path = _resolve_mapped_path(filepath_or_buffer)
        if isinstance(resolved_path, str):
            if not _is_path_inside(resolved_path, cwd):
                raise PermissionError(f"Security Sandbox: Access denied to path '{filepath_or_buffer}'. Only files within the project are allowed.")
        return original_read_csv(resolved_path, *args, **kwargs)

    def _sandboxed_read_excel(io_path, *args, **kwargs):
        if not cwd:
            raise RuntimeError("请不要在自定义脚本中直接读取本地文件；请通过上传数据并使用 _uploaded_data。")
        resolved_path = _resolve_mapped_path(io_path)
        if isinstance(resolved_path, str):
            if not _is_path_inside(resolved_path, cwd):
                raise PermissionError(f"Security Sandbox: Access denied to path '{io_path}'. Only files within the project are allowed.")
        return original_read_excel(resolved_path, *args, **kwargs)

    plt.show = _blocked_show
    plt.savefig = _blocked_savefig
    Figure.savefig = _blocked_savefig
    if original_read_csv is not None:
        pd.read_csv = _sandboxed_read_csv
    if original_read_excel is not None:
        pd.read_excel = _sandboxed_read_excel

    try:
        yield
    finally:
        plt.show = original_show
        plt.savefig = original_savefig
        Figure.savefig = original_fig_savefig
        if original_read_csv is not None:
            pd.read_csv = original_read_csv
        if original_read_excel is not None:
            pd.read_excel = original_read_excel


# ---------------------------------------------------------------------------
# Single source of truth for gid → artist traversal
# ---------------------------------------------------------------------------

def iter_artists(fig):
    """Yield (gid, kind, artist) for all recognised artists.

    This is the ONLY place that defines the gid→artist mapping.
    Both `introspect_figure` and `apply_edit_log` MUST call this function
    to guarantee consistency.  The `kind` is determined here at iteration
    time (from which list the artist lives in), NOT inferred from the gid.
    """
    import warnings
    for i, text in enumerate(fig.texts):
        yield f"fig_text.{i}", "text", text

    for ax_idx, ax in enumerate(fig.axes):
        # Freeze ticks so that their `gid` and properties are preserved during savefig
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if ax.xaxis.get_scale() == 'linear' or ax.xaxis.get_scale() == 'log':
                ax.set_xticks(ax.get_xticks())
                ax.set_xticklabels([t.get_text() for t in ax.get_xticklabels()])
            if ax.yaxis.get_scale() == 'linear' or ax.yaxis.get_scale() == 'log':
                ax.set_yticks(ax.get_yticks())
                ax.set_yticklabels([t.get_text() for t in ax.get_yticklabels()])

        yield f"axes.{ax_idx}", "axes", ax
        yield f"grid.{ax_idx}", "grid", ax
        for i, line in enumerate(ax.xaxis.get_gridlines()):
            yield f"grid.{ax_idx}.line.x.{i}", "grid_line", line
        for i, line in enumerate(ax.yaxis.get_gridlines()):
            yield f"grid.{ax_idx}.line.y.{i}", "grid_line", line
        yield f"spine_group.{ax_idx}", "spine_group", ax
        yield f"axis.x.{ax_idx}", "axis_x", ax.xaxis
        yield f"axis.y.{ax_idx}", "axis_y", ax.yaxis
        yield f"title.{ax_idx}", "text", ax.title
        if hasattr(ax, '_left_title') and ax._left_title:
            yield f"title.left.{ax_idx}", "text", ax._left_title
        if hasattr(ax, '_right_title') and ax._right_title:
            yield f"title.right.{ax_idx}", "text", ax._right_title
        yield f"xlabel.{ax_idx}", "text", ax.xaxis.label
        yield f"ylabel.{ax_idx}", "text", ax.yaxis.label

        for side in ("left", "right", "top", "bottom"):
            yield f"spine.{side}.{ax_idx}", "spine", ax.spines[side]

        for i, label in enumerate(ax.get_xticklabels()):
            yield f"xtick.{ax_idx}.{i}", "text", label
        for i, label in enumerate(ax.get_yticklabels()):
            yield f"ytick.{ax_idx}.{i}", "text", label

        legend = ax.get_legend()
        if legend is not None:
            yield f"legend.{ax_idx}", "legend", legend
            title = legend.get_title()
            if title is not None:
                yield f"legend_title.{ax_idx}", "text", title
            
            texts = legend.get_texts()
            for i, text in enumerate(texts):
                yield f"legend_text.{ax_idx}.{i}", "text", text
            for i, line in enumerate(legend.get_lines()):
                if i < len(texts):
                    line.set_label(texts[i].get_text())
                yield f"legend_line.{ax_idx}.{i}", "line", line
            for i, patch in enumerate(legend.get_patches()):
                if i < len(texts):
                    patch.set_label(texts[i].get_text())
                yield f"legend_patch.{ax_idx}.{i}", "patch", patch

        for i, text in enumerate(ax.texts):
            yield f"text.{ax_idx}.{i}", "text", text

        for i, line in enumerate(ax.lines):
            yield f"line.{ax_idx}.{i}", "line", line

        for i, coll in enumerate(ax.collections):
            yield f"collection.{ax_idx}.{i}", "collection", coll

        # Build patch-to-container-label map
        patch_labels = {}
        for container in ax.containers:
            label = container.get_label()
            if label and not label.startswith('_nolegend_'):
                for child in getattr(container, 'patches', []):
                    patch_labels[child] = label
                try:
                    for child in container:
                        patch_labels[child] = label
                except TypeError:
                    pass

        for i, patch in enumerate(ax.patches):
            if patch in patch_labels:
                patch.set_label(patch_labels[patch])
            yield f"patch.{ax_idx}.{i}", "patch", patch


# ---------------------------------------------------------------------------
# Property readers  (artist → plain dict)
# ---------------------------------------------------------------------------

def _get_text_coord_system(artist) -> str:
    transform = artist.get_transform()
    ax = artist.axes
    if ax is not None:
        if transform == ax.transAxes:
            return "axes"
        if transform == ax.transData:
            return "data"
    fig = artist.figure
    if fig is not None:
        if transform == fig.transFigure:
            return "figure"
    return "axes"

def _read_text_props(artist) -> dict:
    x, y = artist.get_position()
    
    from matplotlib import colors as mcolors
    def to_hex_safe(c):
        try:
            return mcolors.to_hex(c, keep_alpha=False)
        except Exception:
            return "#000000"

    return {
        "text": artist.get_text(),
        "fontsize": artist.get_fontsize(),
        "color": to_hex_safe(artist.get_color()),
        "fontfamily": artist.get_fontname(),
        "x": float(x),
        "y": float(y),
        "coord_system": _get_text_coord_system(artist),
        "ha": artist.get_horizontalalignment(),
        "va": artist.get_verticalalignment(),
        "rotation": float(artist.get_rotation()),
    }


def _read_spine_props(artist) -> dict:
    edge = artist.get_edgecolor()
    return {
        "visible": bool(artist.get_visible()),
        "color": edge if isinstance(edge, str) else list(edge),
        "linewidth": artist.get_linewidth(),
    }


def _read_legend_props(artist) -> dict:
    frame = artist.get_frame()
    fc = frame.get_facecolor()
    ec = frame.get_edgecolor()
    
    from matplotlib import colors as mcolors
    def to_hex_safe(c):
        try:
            return mcolors.to_hex(c, keep_alpha=False)
        except Exception:
            return "#ffffff"
            
    return {
        "visible": bool(artist.get_visible()),
        "fontsize": artist.get_texts()[0].get_fontsize() if artist.get_texts() else 10,
        "frameon": bool(frame.get_visible()),
        "facecolor": to_hex_safe(fc),
        "edgecolor": to_hex_safe(ec),
        "linewidth": frame.get_linewidth(),
        "alpha": frame.get_alpha() if frame.get_alpha() is not None else 1.0,
        "loc": _legend_loc_to_string(getattr(artist, "_loc", None)),
        "ncol": getattr(artist, "_ncols", 1),
        "markerscale": getattr(artist, "markerscale", 1.0) or 1.0,
        "title": artist.get_title().get_text() if artist.get_title() is not None else "",
        "fontfamily": artist.get_texts()[0].get_fontname() if artist.get_texts() else "",
    }


def _read_line_props(artist) -> dict:
    return {
        "color": artist.get_color(),
        "linewidth": artist.get_linewidth(),
        "linestyle": artist.get_linestyle(),
        "alpha": artist.get_alpha(),
    }


def _read_collection_props(artist) -> dict:
    fc = artist.get_facecolor()
    ec = artist.get_edgecolor()
    return {
        "facecolor": fc.tolist() if hasattr(fc, "tolist") else fc,
        "edgecolor": ec.tolist() if hasattr(ec, "tolist") else ec,
        "alpha": artist.get_alpha(),
    }


def _read_patch_props(artist) -> dict:
    fc = artist.get_facecolor()
    ec = artist.get_edgecolor()
    return {
        "facecolor": fc.tolist() if hasattr(fc, "tolist") else list(fc) if isinstance(fc, tuple) else fc,
        "edgecolor": ec.tolist() if hasattr(ec, "tolist") else list(ec) if isinstance(ec, tuple) else ec,
        "alpha": artist.get_alpha(),
        "linewidth": artist.get_linewidth(),
    }


def _read_axes_props(artist) -> dict:
    xlim = list(artist.get_xlim())
    ylim = list(artist.get_ylim())
    
    from matplotlib.ticker import NullLocator
    show_minor_ticks = not isinstance(artist.xaxis.get_minor_locator(), NullLocator)
    
    rotation = 0
    labels = artist.get_xticklabels()
    if labels:
        try:
            rotation = float(labels[0].get_rotation())
        except Exception:
            pass
            
    tick_dir = "out"
    return {
        "xlim": xlim,
        "ylim": ylim,
        "show_minor_ticks": show_minor_ticks,
        "x_tick_rotation": rotation,
        "tick_direction": tick_dir,
    }


def _get_tick_metric(tick, metric: str, fallback: Any) -> Any:
    if tick is None:
        return fallback
    if metric == "length":
        return tick.tick1line.get_markersize()
    if metric == "width":
        return tick.tick1line.get_markeredgewidth()
    if metric == "color":
        color = tick.tick1line.get_color()
        try:
            return mcolors.to_hex(color, keep_alpha=False)
        except Exception:
            return color
    if metric == "pad":
        getter = getattr(tick, "get_pad", None)
        if callable(getter):
            try:
                return getter()
            except Exception:
                pass
        return getattr(tick, "_base_pad", fallback)
    if metric == "direction":
        return getattr(tick, "_tickdir", fallback)
    return fallback


def _read_axis_props(axis, axis_name: str) -> dict:
    major_ticks = axis.get_major_ticks()
    major_tick = major_ticks[0] if major_ticks else None
    minor_ticks = axis.get_minor_ticks()
    minor_tick = minor_ticks[0] if minor_ticks else None
    labels = axis.get_ticklabels()
    rotation = 0.0
    if labels:
        try:
            rotation = float(labels[0].get_rotation())
        except Exception:
            pass

    formatter = axis.get_major_formatter()
    sci_notation = bool(getattr(formatter, "_scientific", False))
    use_math_text = bool(getattr(formatter, "_useMathText", False))
    label_obj = axis.label
    label_color = label_obj.get_color() if label_obj is not None else "#000000"
    try:
        label_color = mcolors.to_hex(label_color, keep_alpha=False)
    except Exception:
        pass

    return {
        "limits": list(axis.axes.get_xlim() if axis_name == "x" else axis.axes.get_ylim()),
        "label": label_obj.get_text() if label_obj is not None else "",
        "label_fontsize": label_obj.get_fontsize() if label_obj is not None else 12,
        "label_color": label_color,
        "tick_rotation": rotation,
        "tick_direction": _get_tick_metric(major_tick, "direction", "out"),
        "tick_length": _get_tick_metric(major_tick, "length", 3.5),
        "tick_width": _get_tick_metric(major_tick, "width", 0.8),
        "tick_color": _get_tick_metric(major_tick, "color", "#000000"),
        "tick_pad": _get_tick_metric(major_tick, "pad", 3.5),
        "minor_tick_length": _get_tick_metric(minor_tick, "length", 2.0),
        "minor_tick_width": _get_tick_metric(minor_tick, "width", 0.6),
        "minor_tick_color": _get_tick_metric(minor_tick, "color", "#000000"),
        "show_minor_ticks": len(minor_ticks) > 0,
        "tick_labelsize": labels[0].get_fontsize() if labels else 10,
        "tick_labelcolor": _get_tick_metric(major_tick, "color", "#000000"),
        "sci_notation": sci_notation,
        "use_math_text": use_math_text,
        "offset_text_size": axis.get_offset_text().get_fontsize(),
    }


def _read_spine_group_props(ax) -> dict:
    sample = ax.spines["left"]
    return {
        "visible": all(spine.get_visible() for spine in ax.spines.values()),
        "color": _read_spine_props(sample)["color"],
        "linewidth": sample.get_linewidth(),
    }


def _read_grid_props(artist) -> dict:
    x_lines = artist.xaxis.get_gridlines()
    y_lines = artist.yaxis.get_gridlines()
    all_lines = list(x_lines) + list(y_lines)
    visible = any(line.get_visible() for line in all_lines)
    if all_lines:
        line = all_lines[0]
        color = line.get_color()
        lw = line.get_linewidth()
        ls = line.get_linestyle()
        alpha = line.get_alpha()
        
        from matplotlib import colors as mcolors
        try:
            hex_color = mcolors.to_hex(color, keep_alpha=False)
        except Exception:
            hex_color = "#cccccc"
            
        return {
            "visible": bool(visible),
            "color": hex_color,
            "linewidth": lw if lw is not None else 0.5,
            "linestyle": ls if ls is not None else "-",
            "alpha": alpha if alpha is not None else 1.0,
        }
    return {
        "visible": bool(visible),
        "color": "#cccccc",
        "linewidth": 0.5,
        "linestyle": "-",
        "alpha": 1.0,
    }


_READERS = {
    "text": _read_text_props,
    "spine": _read_spine_props,
    "spine_group": _read_spine_group_props,
    "legend": _read_legend_props,
    "line": _read_line_props,
    "collection": _read_collection_props,
    "patch": _read_patch_props,
    "axes": _read_axes_props,
    "grid": _read_grid_props,
    "axis_x": lambda artist: _read_axis_props(artist, "x"),
    "axis_y": lambda artist: _read_axis_props(artist, "y"),
}


def _read_props(artist, kind: str) -> dict:
    reader = _READERS.get(kind)
    if reader is None:
        return {}
    props = reader(artist)
    if hasattr(artist, "get_zorder"):
        try:
            props["zorder"] = float(artist.get_zorder())
        except Exception:
            pass
    return props


def _safe_artist_label(artist, fallback: str) -> str:
    getter = getattr(artist, "get_label", None)
    if not callable(getter):
        return fallback
    try:
        raw = getter()
    except Exception:
        return fallback
    if raw is None:
        return fallback
    if isinstance(raw, str):
        return raw or fallback
    text_getter = getattr(raw, "get_text", None)
    if callable(text_getter):
        try:
            text = text_getter()
            if isinstance(text, str) and text:
                return text
        except Exception:
            pass
    return fallback


# ---------------------------------------------------------------------------
# Editable fields per kind
# ---------------------------------------------------------------------------

_EDITABLE = {
    "text": ["text", "fontsize", "fontfamily", "color", "zorder"],
    "spine": ["visible", "color", "linewidth", "zorder"],
    "spine_group": ["visible", "color", "linewidth", "zorder"],
    "legend": ["visible", "fontsize", "frameon", "facecolor", "edgecolor", "linewidth", "alpha", "loc", "ncol", "markerscale", "title", "fontfamily", "zorder"],
    "line": ["color", "linewidth", "linestyle", "alpha", "zorder"],
    "patch": ["facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
    "collection": ["facecolor", "edgecolor", "alpha", "zorder"],
    "axes": ["xlim", "ylim", "show_minor_ticks", "x_tick_rotation", "tick_direction", "zorder"],
    "grid": ["visible", "color", "linewidth", "linestyle", "alpha", "zorder"],
    "axis_x": ["limits", "label", "label_fontsize", "label_color", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad", "minor_tick_length", "minor_tick_width", "minor_tick_color", "show_minor_ticks", "tick_labelsize", "tick_labelcolor", "sci_notation", "use_math_text", "offset_text_size"],
    "axis_y": ["limits", "label", "label_fontsize", "label_color", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad", "minor_tick_length", "minor_tick_width", "minor_tick_color", "show_minor_ticks", "tick_labelsize", "tick_labelcolor", "sci_notation", "use_math_text", "offset_text_size"],
}


def _get_editable(kind: str) -> list:
    return _EDITABLE.get(kind, [])


# ---------------------------------------------------------------------------
# Kind from gid prefix
# ---------------------------------------------------------------------------

# (removed: kind is now yielded directly by iter_artists, not inferred from gid)


# ---------------------------------------------------------------------------
# Introspection entry point
# ---------------------------------------------------------------------------

def introspect_figure(fig, semantic_manifest=None) -> dict:
    """Accept a fully rendered Figure, return {svg, manifest}."""

    # 1. Bind gids and read properties
    objects = []
    for gid, kind, artist in iter_artists(fig):
        if artist is None:
            continue
        artist.set_gid(gid)
        if kind == "grid_line":
            continue
        objects.append({
            "id": gid,
            "kind": kind,
            "label": _safe_artist_label(artist, gid),
            "editable": _get_editable(kind),
            "currentProps": _read_props(artist, kind),
        })

    # 2. Build color groups (same-colored artists → batch editing)
    def _normalize_color(val):
        if val is None:
            return None
        # Handle collection facecolor array (Nx4) — check if uniform
        if isinstance(val, (list, tuple)) and len(val) > 0 and isinstance(val[0], (list, tuple)):
            first = val[0]
            for row in val[1:]:
                if len(row) != len(first) or any(abs(a - b) > 1e-6 for a, b in zip(row, first)):
                    return None
            val = first
        try:
            return mcolors.to_hex(val, keep_alpha=False)
        except (ValueError, AttributeError, TypeError):
            return None

    color_groups = {}
    for obj in objects:
        hex_color = None
        for prop in ('facecolor', 'color', 'edgecolor'):
            val = obj.get('currentProps', {}).get(prop)
            if val is not None:
                h = _normalize_color(val)
                if h:
                    hex_color = h
                    break
        if not hex_color:
            continue
        if hex_color not in color_groups:
            color_groups[hex_color] = {
                "color": hex_color,
                "label": obj.get('label') or obj['id'],
                "gids": [],
                "count": 0,
            }
        color_groups[hex_color]["gids"].append(obj['id'])
        color_groups[hex_color]["count"] += 1

    # Pick best label: use first non-gid-looking label
    for group in color_groups.values():
        for obj in objects:
            if obj['id'] in group['gids']:
                lbl = obj.get('label') or ''
                if lbl and not lbl.startswith(('line.', 'collection.', 'patch.', 'text.', 'xtick.', 'ytick.')):
                    group['label'] = lbl
                    break

    # 3. Deterministic SVG output
    matplotlib.rcParams["svg.hashsalt"] = "scifigure-v1"
    matplotlib.rcParams["svg.fonttype"] = "none"
    buf = io.BytesIO()
    fig.savefig(
        buf,
        format="svg",
        metadata={"Date": None},
        bbox_inches="tight",
    )
    svg = buf.getvalue().decode("utf-8")

    # Integrate binding engine
    bindings_list = []
    palettes_list = []
    groups_list = []
    if semantic_manifest:
        try:
            from binding_engine import build_bindings
            bindings_list = build_bindings(semantic_manifest, objects)
            palettes_list = semantic_manifest.get("palettes", [])
            groups_list = semantic_manifest.get("groups", [])
        except Exception as e:
            import sys
            print(f"Error building bindings: {e}", file=sys.stderr)

    # 3. Build manifest
    manifest = {
        "generatedBy": "introspection",
        "globals": {
            "figure.width_in": {
                "type": "number",
                "value": fig.get_figwidth(),
                "min": 2,
                "max": 30,
                "step": 0.1,
            },
            "figure.height_in": {
                "type": "number",
                "value": fig.get_figheight(),
                "min": 2,
                "max": 30,
                "step": 0.1,
            },
            "figure.dpi": {
                "type": "number",
                "value": fig.dpi if hasattr(fig, "dpi") else 150,
                "min": 72,
                "max": 600,
                "step": 1,
            },
        },
        "objects": objects,
        "colorGroups": list(color_groups.values()),
        "palettes": palettes_list,
        "groups": groups_list,
        "bindings": bindings_list if isinstance(bindings_list, list) and len(bindings_list) > 0 else [],
        "capabilities": {
            "localPatch": True,
            "backendPatch": True,
            "codePatch": True,
        },
        "coverageReport": {
            "title": "full",
            "axisLabels": "full",
            "spines": "full",
            "legend": "full",
            "dataSeries": "partial",
            "annotations": "none",
        },
        "unsupportedNotes": [
            "数据排序逻辑仅可通过 code_patch 修改",
            "自定义 annotation 位置规则不可 live 编辑",
        ],
    }

    return {"svg": svg, "manifest": manifest}


# ---------------------------------------------------------------------------
# Edit application  (edit_log → artist setter calls)
# ---------------------------------------------------------------------------

_LEGEND_LOC_MAP = {
    0: "best",
    1: "upper right",
    2: "upper left",
    3: "lower left",
    4: "lower right",
    5: "right",
    6: "center left",
    7: "center right",
    8: "lower center",
    9: "upper center",
    10: "center",
}


def _legend_loc_to_string(loc: Any) -> str:
    if isinstance(loc, str):
        return loc
    if isinstance(loc, int):
        return _LEGEND_LOC_MAP.get(loc, "best")
    return "best"

# Map manifest prop names → matplotlib setter method names
_PROP_TO_SETTER = {
    "text": "set_text",
    "fontsize": "set_fontsize",
    "fontfamily": "set_fontname",
    "color": "set_color",
    "visible": "set_visible",
    "linewidth": "set_linewidth",
    "linestyle": "set_linestyle",
    "alpha": "set_alpha",
    "facecolor": "set_facecolor",
    "edgecolor": "set_edgecolor",
    "zorder": "set_zorder",
}


def _apply_single(artist, prop: str, value: Any, gid: str = ""):
    if gid.startswith("axes."):
        if prop == "xlim":
            artist.set_xlim(float(value[0]), float(value[1]))
        elif prop == "ylim":
            artist.set_ylim(float(value[0]), float(value[1]))
        elif prop == "x_tick_rotation":
            for label in artist.get_xticklabels():
                label.set_rotation(float(value))
        elif prop == "tick_direction":
            artist.tick_params(axis='both', which='both', direction=str(value))
        elif prop == "show_minor_ticks":
            if value:
                artist.minorticks_on()
            else:
                artist.minorticks_off()
        elif prop == "minor_tick_length":
            artist.tick_params(axis='both', which='minor', length=float(value))
        elif prop == "minor_tick_width":
            artist.tick_params(axis='both', which='minor', width=float(value))
        elif prop == "show_ticks":
            artist.tick_params(axis='both', which='major', bottom=bool(value), top=bool(value), left=bool(value), right=bool(value))
        return

    if gid.startswith("grid."):
        if prop == "visible":
            artist.grid(bool(value), which='major')
        elif prop == "color":
            artist.grid(True, which='major', color=value)
        elif prop == "linewidth":
            artist.grid(True, which='major', linewidth=float(value))
        elif prop == "linestyle":
            artist.grid(True, which='major', linestyle=str(value))
        elif prop == "alpha":
            artist.grid(True, which='major', alpha=float(value))
        return

    if gid.startswith("spine_group."):
        for spine in artist.spines.values():
            _apply_single(spine, prop, value, "")
        return

    if gid.startswith("axis.x.") or gid.startswith("axis.y."):
        axis_name = "x" if gid.startswith("axis.x.") else "y"
        parent_ax = artist.axes
        if prop == "limits":
            low = float(value[0])
            high = float(value[1])
            if axis_name == "x":
                parent_ax.set_xlim(low, high)
            else:
                parent_ax.set_ylim(low, high)
            return
        if prop == "label":
            artist.label.set_text(str(value))
            return
        if prop == "label_fontsize":
            artist.label.set_fontsize(float(value))
            return
        if prop == "label_color":
            artist.label.set_color(value)
            return
        if prop == "tick_rotation":
            for label in artist.get_ticklabels():
                label.set_rotation(float(value))
            return
        if prop == "tick_labelsize":
            parent_ax.tick_params(axis=axis_name, which="major", labelsize=float(value))
            return
        if prop == "tick_labelcolor":
            parent_ax.tick_params(axis=axis_name, which="major", labelcolor=value, colors=value)
            return
        if prop == "tick_direction":
            parent_ax.tick_params(axis=axis_name, which="both", direction=str(value))
            return
        if prop == "tick_length":
            parent_ax.tick_params(axis=axis_name, which="major", length=float(value))
            return
        if prop == "tick_width":
            parent_ax.tick_params(axis=axis_name, which="major", width=float(value))
            return
        if prop == "tick_color":
            parent_ax.tick_params(axis=axis_name, which="major", colors=value)
            return
        if prop == "tick_pad":
            parent_ax.tick_params(axis=axis_name, which="major", pad=float(value))
            return
        if prop == "minor_tick_length":
            parent_ax.tick_params(axis=axis_name, which="minor", length=float(value))
            return
        if prop == "minor_tick_width":
            parent_ax.tick_params(axis=axis_name, which="minor", width=float(value))
            return
        if prop == "minor_tick_color":
            parent_ax.tick_params(axis=axis_name, which="minor", colors=value)
            return
        if prop == "show_minor_ticks":
            if value:
                parent_ax.minorticks_on()
            else:
                parent_ax.minorticks_off()
            return
        if prop == "sci_notation":
            style = "sci" if value else "plain"
            parent_ax.ticklabel_format(axis=axis_name, style=style, useMathText=_read_axis_props(artist, axis_name).get("use_math_text", False))
            return
        if prop == "use_math_text":
            style = "sci" if _read_axis_props(artist, axis_name).get("sci_notation") else "plain"
            parent_ax.ticklabel_format(axis=axis_name, style=style, useMathText=bool(value))
            return
        if prop == "offset_text_size":
            artist.get_offset_text().set_fontsize(float(value))
            return

    if gid.startswith("legend."):
        frame = artist.get_frame()
        if prop == "visible":
            artist.set_visible(bool(value))
        elif prop == "fontsize":
            for text in artist.get_texts():
                text.set_fontsize(float(value))
            title = artist.get_title()
            if title is not None:
                title.set_fontsize(float(value))
        elif prop == "frameon":
            frame.set_visible(bool(value))
        elif prop == "facecolor":
            frame.set_facecolor(value)
        elif prop == "edgecolor":
            frame.set_edgecolor(value)
        elif prop == "linewidth":
            frame.set_linewidth(float(value))
        elif prop == "alpha":
            frame.set_alpha(float(value))
        elif prop == "loc":
            artist.set_loc(str(value))
        elif prop == "ncol":
            artist.set_ncols(int(value))
        elif prop == "markerscale":
            artist.markerscale = float(value)
        elif prop == "title":
            artist.set_title(str(value))
        elif prop == "fontfamily":
            for text in artist.get_texts():
                text.set_fontname(str(value))
            title = artist.get_title()
            if title is not None:
                title.set_fontname(str(value))
        return

    setter_name = _PROP_TO_SETTER.get(prop)
    if setter_name is None:
        return
    setter = getattr(artist, setter_name, None)
    if setter is None:
        return
    try:
        if prop == "zorder":
            setter(float(value))
        else:
            setter(value)
    except Exception:
        pass  # silently skip incompatible values (e.g. color format mismatch)


def _build_gid_map(fig) -> dict:
    """Rebuild gid → artist mapping via iter_artists (same as introspect)."""
    return {gid: art for gid, kind, art in iter_artists(fig) if art is not None}


def _apply_global(fig, prop: str, value: Any):
    if prop == "figure.width_in":
        fig.set_size_inches(float(value), fig.get_figheight(), forward=True)
        return
    if prop == "figure.height_in":
        fig.set_size_inches(fig.get_figwidth(), float(value), forward=True)
        return
    if prop == "figure.dpi":
        fig.set_dpi(float(value))
        return


def apply_edit_log(fig, edit_log: list[dict]):
    """Apply an edit_log to a Figure in-place.

    Called AFTER the script has been executed but BEFORE introspection.
    """
    gid_map = _build_gid_map(fig)

    for entry in edit_log:
        gid = entry.get("gid")
        prop = entry.get("prop")
        value = entry.get("value")

        if gid == "global":
            _apply_global(fig, prop, value)
            continue

        artist = gid_map.get(gid)
        if artist is None:
            continue
        _apply_single(artist, prop, value, gid)


# ---------------------------------------------------------------------------
# Full replay pipeline
# ---------------------------------------------------------------------------

def replay_render(
    script: str,
    data: Optional[dict] = None,
    edit_log: Optional[list] = None,
    dpi: int = 150,
    export_format: str = None,
    cwd: Optional[str] = None,
    uploaded_file_paths: Optional[dict] = None,
    edit_logs: Optional[dict] = None
) -> dict:
    """Execute a matplotlib script, apply edit_log(s), produce SVGs + manifests.

    Supports single or multiple figures.
    """
    import time
    import io
    import os
    import base64
    import matplotlib.pyplot as plt

    start = time.time()
    
    # Clear the figure registry for this run
    _figure_registry.clear()

    # Parse AST / regex static scan
    semantic_manifest = None
    try:
        from semantic_scanner import scan_source
        semantic_manifest = scan_source(script)
    except Exception as e:
        import sys
        print(f"Error scanning source statically: {e}", file=sys.stderr)

    # --- 1. Switch working directory if provided ---
    original_cwd = os.getcwd()
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)

    # --- 2. Execute script ---
    ns: dict = {
        "__name__": "__main__",
        "_uploaded_data": data.get("custom_data", []) if data else [],
    }
    if uploaded_file_paths:
        ns["_uploaded_file_paths"] = uploaded_file_paths

    try:
        with _guard_user_script_io(cwd, uploaded_file_paths=uploaded_file_paths, original_cwd=original_cwd):
            exec(script, ns, ns)
    except Exception as exc:
        os.chdir(original_cwd)
        return {
            "status": "error",
            "message": _build_script_error_message(exc, data),
            "traceback": traceback.format_exc(),
            "timingMs": int((time.time() - start) * 1000),
        }

    # Fallback/dynamic updates from namespace
    if semantic_manifest:
        try:
            from semantic_scanner import scan_source
            semantic_manifest = scan_source(script, namespace=ns)
        except Exception as e:
            import sys
            print(f"Error scanning source dynamically: {e}", file=sys.stderr)

    # --- 3. Fallback scan for active figures ---
    for num in plt.get_fignums():
        try:
            fig = plt.figure(num)
            if fig not in _figure_registry:
                _figure_registry.append(fig)
        except Exception:
            pass

    # Deduplicate keeping order, filter out figures with no axes
    seen = set()
    unique_figures = []
    for fig in _figure_registry:
        if id(fig) not in seen:
            seen.add(id(fig))
            if fig.axes:  # Only process figures with axes
                unique_figures.append(fig)

    if not unique_figures:
        os.chdir(original_cwd)
        return {
            "status": "error",
            "message": "脚本未创建任何 matplotlib Figure",
            "timingMs": int((time.time() - start) * 1000),
        }

    # --- 4. Process each Figure ---
    figures_data = []
    for idx, fig in enumerate(unique_figures):
        fig_id = f"fig_{idx + 1}"
        
        # Determine the edit log to apply for this figure
        fig_edit_log = []
        if edit_logs and isinstance(edit_logs, dict):
            fig_edit_log = edit_logs.get(fig_id, [])
        elif idx == 0 and edit_log:
            fig_edit_log = edit_log

        # Apply edit log
        if fig_edit_log:
            apply_edit_log(fig, fig_edit_log)

        # Introspect
        result = introspect_figure(fig, semantic_manifest=semantic_manifest)
        
        # Render and export to binary format if requested
        binary_b64 = None
        if export_format and export_format.lower() in ['png', 'pdf', 'tiff', 'eps']:
            buf = io.BytesIO()
            fmt = export_format.lower()
            if fmt == 'tiff':
                from PIL import Image
                png_buf = io.BytesIO()
                fig.savefig(png_buf, format='png', dpi=dpi, bbox_inches='tight')
                png_buf.seek(0)
                img = Image.open(png_buf)
                img.save(buf, format='TIFF', compression='tiff_lzw')
            else:
                fig.savefig(buf, format=fmt, dpi=dpi, bbox_inches='tight')
            binary_b64 = base64.b64encode(buf.getvalue()).decode('utf-8')

        fig_entry = {
            "figureId": fig_id,
            "svg": result["svg"],
            "manifest": result["manifest"],
        }
        if binary_b64:
            fig_entry["binary_b64"] = binary_b64
            fig_entry["format"] = export_format.lower()

        figures_data.append(fig_entry)

    plt.close("all")
    os.chdir(original_cwd)
    
    elapsed = int((time.time() - start) * 1000)

    # Return unified response ensuring backward compatibility
    ret = {
        "status": "success",
        "timingMs": elapsed,
        "message": "Replay render completed.",
    }
    
    # Populate top-level fields from the first figure (compatibility)
    ret["svg"] = figures_data[0]["svg"]
    ret["manifest"] = figures_data[0]["manifest"]
    if "binary_b64" in figures_data[0]:
        ret["binary_b64"] = figures_data[0]["binary_b64"]
        ret["format"] = figures_data[0]["format"]
        
    # Expose figures list
    ret["figures"] = figures_data
    return ret


# ---------------------------------------------------------------------------
# Deterministic SVG validation helper
# ---------------------------------------------------------------------------

def validate_deterministic(svg_a: str, svg_b: str) -> bool:
    """Check if two SVG strings are functionally identical.

    Strips non-deterministic metadata and compares.
    """
    def _normalise(s: str) -> str:
        s = re.sub(r'\s+xmlns:dc="[^"]*"', "", s)
        s = re.sub(r'\s+xmlns:cc="[^"]*"', "", s)
        s = re.sub(r'\s+xmlns:rdf="[^"]*"', "", s)
        s = re.sub(r'<metadata>.*?</metadata>', "", s, flags=re.DOTALL)
        s = re.sub(r'\s+', " ", s)
        return s.strip()

    return _normalise(svg_a) == _normalise(svg_b)


# ---------------------------------------------------------------------------
# CLI entry point for testing
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    input_data = sys.stdin.read()
    payload = json.loads(input_data)

    script = payload.get("script", "")
    data = payload.get("dataPayload") or payload.get("data")
    edit_log = payload.get("editLog", [])
    dpi = payload.get("renderOptions", {}).get("dpi", 150)
    export_format = payload.get("export_format")
    
    cwd = payload.get("cwd")
    uploaded_file_paths = payload.get("uploaded_file_paths")
    edit_logs = payload.get("editLogs")

    result = replay_render(
        script, 
        data, 
        edit_log, 
        dpi, 
        export_format, 
        cwd=cwd, 
        uploaded_file_paths=uploaded_file_paths, 
        edit_logs=edit_logs
    )
    # Add a deterministic sessionId
    import hashlib
    result["sessionId"] = hashlib.md5(script.encode()).hexdigest()[:12]
    print(json.dumps(result))
