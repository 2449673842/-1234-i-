from __future__ import annotations

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
import hashlib
import traceback
import ast
import time
import copy
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
from matplotlib.axes import Axes

original_fig_init = Figure.__init__

def patched_fig_init(self, *args, **kwargs):
    original_fig_init(self, *args, **kwargs)
    _register_figure(self)

Figure.__init__ = patched_fig_init


_intercepted_containers = []

class BoxplotContainer:
    def __init__(self, bp_dict, label=""):
        self.bp_dict = bp_dict
        self._label = label
    def get_label(self):
        return self._label
    def set_label(self, val):
        self._label = val
    def get_children(self):
        children = []
        for val in self.bp_dict.values():
            if isinstance(val, list):
                children.extend(val)
            elif val is not None:
                children.append(val)
        return children

class ViolinplotContainer:
    def __init__(self, vp_dict, label=""):
        self.vp_dict = vp_dict
        self._label = label
    def get_label(self):
        return self._label
    def set_label(self, val):
        self._label = val
    def get_children(self):
        children = []
        for val in self.vp_dict.values():
            if isinstance(val, list):
                children.extend(val)
            elif val is not None:
                children.append(val)
        return children

# Monkey patch Axes.boxplot and Axes.violinplot
original_boxplot = Axes.boxplot
original_violinplot = Axes.violinplot

def patched_boxplot(self, *args, **kwargs):
    res = original_boxplot(self, *args, **kwargs)
    container_obj = BoxplotContainer(res)
    _intercepted_containers.append({
        "axes": self,
        "type": "boxplot",
        "container": container_obj
    })
    return res

def patched_violinplot(self, *args, **kwargs):
    res = original_violinplot(self, *args, **kwargs)
    container_obj = ViolinplotContainer(res)
    _intercepted_containers.append({
        "axes": self,
        "type": "violinplot",
        "container": container_obj
    })
    return res

Axes.boxplot = patched_boxplot
Axes.violinplot = patched_violinplot


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

    from urllib.parse import urlparse

    BLOCKED_SCHEMES = {
        "http",
        "https",
        "ftp",
        "ftps",
        "s3",
        "gs",
        "file",
    }

    def _reject_protocol_path(path):
        if not isinstance(path, str):
            return
        parsed = urlparse(path.strip())
        if parsed.scheme and parsed.scheme.lower() in BLOCKED_SCHEMES:
            raise PermissionError(f"Protocol paths are not allowed: {path}")

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
        else:
            # 处理值匹配：用户通过 _uploaded_file_paths[key] 取值后传入 read_csv
            # 此时 filepath_or_buffer 是存储路径（相对服务端根目录），键表查不到
            for v in uploaded_file_paths.values():
                if v == filepath_or_buffer or v == lookup_key:
                    mapped = v
                    break
            
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
        _reject_protocol_path(filepath_or_buffer)
        if not cwd:
            raise RuntimeError("请不要在自定义脚本中直接读取本地文件；请通过上传数据并使用 _uploaded_data。")
        resolved_path = _resolve_mapped_path(filepath_or_buffer)
        if isinstance(resolved_path, str):
            if not _is_path_inside(resolved_path, cwd):
                raise PermissionError(f"Security Sandbox: Access denied to path '{filepath_or_buffer}'. Only files within the project are allowed.")
        return original_read_csv(resolved_path, *args, **kwargs)

    def _sandboxed_read_excel(io_path, *args, **kwargs):
        _reject_protocol_path(io_path)
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
            _freeze_ticklabels_preserving_style(ax)

        yield f"axes.{ax_idx}", "axes", ax
        try:
            ax.patch.set_gid(f"axes.patch.{ax_idx}")
        except Exception:
            pass
        if not _is_colorbar_axes(ax):
            yield f"subplot.{ax_idx}", "subplot", ax
        
        # Yield containers
        for c_idx, container in enumerate(ax.containers):
            if isinstance(container, matplotlib.container.BarContainer):
                kind = "bar_container"
            elif isinstance(container, matplotlib.container.ErrorbarContainer):
                kind = "errorbar_container"
            elif isinstance(container, matplotlib.container.StemContainer):
                kind = "stem_container"
            else:
                kind = "container"
            yield f"container.{kind.replace('_container', '')}.{ax_idx}.{c_idx}", kind, container

        # Yield intercepted boxplot/violinplot containers
        ax_intercepted = [item for item in _intercepted_containers if item["axes"] == ax]
        for c_idx, item in enumerate(ax_intercepted):
            container_obj = item["container"]
            kind = f"{item['type']}_container"
            yield f"container.{item['type']}.{ax_idx}.{c_idx}", kind, container_obj

        yield f"grid.{ax_idx}", "grid", ax
        for i, line in enumerate(ax.xaxis.get_gridlines()):
            yield f"grid.{ax_idx}.line.x.{i}", "grid_line", line
        for i, line in enumerate(ax.yaxis.get_gridlines()):
            yield f"grid.{ax_idx}.line.y.{i}", "grid_line", line
        yield f"spine_group.{ax_idx}", "spine_group", ax
        yield f"axis.x.{ax_idx}", "axis_x", ax.xaxis
        yield f"axis.y.{ax_idx}", "axis_y", ax.yaxis
        if ax.title is not None and ax.title.get_text():
            yield f"title.{ax_idx}", "text", ax.title
        if hasattr(ax, '_left_title') and ax._left_title and ax._left_title.get_text():
            yield f"title.left.{ax_idx}", "text", ax._left_title
        if hasattr(ax, '_right_title') and ax._right_title and ax._right_title.get_text():
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
            for i, handle in enumerate(_get_legend_handles(legend)):
                if not hasattr(handle, "get_sizes"):
                    continue
                if i < len(texts):
                    handle.set_label(texts[i].get_text())
                yield f"legend_collection.{ax_idx}.{i}", "collection", handle

        annotation_arrow_patches = set()
        for i, text in enumerate(ax.texts):
            yield f"text.{ax_idx}.{i}", "text", text
            try:
                from matplotlib.text import Annotation
                if isinstance(text, Annotation) and text.arrow_patch is not None:
                    annotation_arrow_patches.add(text.arrow_patch)
                    yield f"annotation_arrow.{ax_idx}.{i}", "patch", text.arrow_patch
            except Exception:
                pass

        for i, line in enumerate(ax.lines):
            yield f"line.{ax_idx}.{i}", "line", line

        for i, coll in enumerate(ax.collections):
            import matplotlib.collections as mcoll
            if isinstance(coll, mcoll.QuadMesh):
                yield f"heatmap.mesh.{ax_idx}.{i}", "heatmap", coll
            else:
                yield f"collection.{ax_idx}.{i}", "collection", coll

        import matplotlib.image as mimage
        for i, img in enumerate(ax.images):
            if isinstance(img, mimage.AxesImage):
                yield f"heatmap.image.{ax_idx}.{i}", "heatmap", img

        cbar = getattr(ax, "_colorbar", None)
        if cbar is not None:
            yield f"colorbar.{ax_idx}", "colorbar", cbar

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
            if patch in annotation_arrow_patches:
                continue
            if patch in patch_labels:
                patch.set_label(patch_labels[patch])
            yield f"patch.{ax_idx}.{i}", "patch", patch

    # Figure-level shared legends created by fig.legend(...) are not attached
    # to any Axes, so ax.get_legend() cannot see them. Expose them separately
    # with a non-conflicting gid namespace while keeping the same legend roles.
    for fig_legend_idx, legend in enumerate(getattr(fig, "legends", []) or []):
        if legend is None:
            continue
        yield f"legend.figure.{fig_legend_idx}", "legend", legend
        title = legend.get_title()
        if title is not None and title.get_text():
            yield f"legend_title.figure.{fig_legend_idx}", "text", title

        texts = legend.get_texts()
        for i, text in enumerate(texts):
            yield f"legend_text.figure.{fig_legend_idx}.{i}", "text", text
        for i, line in enumerate(legend.get_lines()):
            if i < len(texts):
                line.set_label(texts[i].get_text())
            yield f"legend_line.figure.{fig_legend_idx}.{i}", "line", line
        for i, patch in enumerate(legend.get_patches()):
            if i < len(texts):
                patch.set_label(texts[i].get_text())
            yield f"legend_patch.figure.{fig_legend_idx}.{i}", "patch", patch
        for i, handle in enumerate(_get_legend_handles(legend)):
            if not hasattr(handle, "get_sizes"):
                continue
            if i < len(texts):
                handle.set_label(texts[i].get_text())
            yield f"legend_collection.figure.{fig_legend_idx}.{i}", "collection", handle


_GENERIC_FONT_FAMILIES = {"serif", "sans-serif", "monospace", "cursive", "fantasy"}
_TIMES_COMPAT_REQUESTS = {"times new roman", "times"}
_TIMES_RUNTIME_CANDIDATES = ("Times New Roman", "Times", "Liberation Serif", "FreeSerif", "serif")


def _font_name_for_family(family: str) -> Optional[str]:
    try:
        from matplotlib.font_manager import FontProperties, findfont

        path = findfont(FontProperties(family=[family]), fallback_to_default=False)
        return FontProperties(fname=path).get_name()
    except Exception:
        return None


def _resolve_runtime_fontfamily(requested: Any) -> str:
    family = str(requested or "").strip()
    if not family:
        return family
    if family.lower() not in _TIMES_COMPAT_REQUESTS:
        return family
    for candidate in _TIMES_RUNTIME_CANDIDATES:
        if _font_name_for_family(candidate):
            return candidate
    return "serif"


def _actual_fontfamily(artist) -> str:
    try:
        from matplotlib.font_manager import FontProperties, findfont

        path = findfont(artist.get_fontproperties(), fallback_to_default=True)
        return FontProperties(fname=path).get_name()
    except Exception:
        try:
            return artist.get_fontname()
        except Exception:
            return ""


def _requested_fontfamily(artist) -> str:
    requested = getattr(artist, "_scifigure_requested_fontfamily", None)
    if requested:
        return str(requested)
    try:
        families = artist.get_fontfamily()
        if isinstance(families, (list, tuple)) and families:
            first = str(families[0])
            if first.lower() not in _GENERIC_FONT_FAMILIES:
                return first
    except Exception:
        pass
    try:
        return artist.get_fontname()
    except Exception:
        return ""


def _set_text_fontfamily(text, requested: Any):
    requested_family = str(requested or "").strip()
    setattr(text, "_scifigure_requested_fontfamily", requested_family)
    resolved_family = _resolve_runtime_fontfamily(requested_family)
    families = [requested_family]
    if resolved_family and resolved_family.lower() != requested_family.lower():
        families.append(resolved_family)
    if requested_family.lower() in _TIMES_COMPAT_REQUESTS:
        families.append("serif")
    text.set_fontfamily(families)


def _normalise_text_runtime_font(text):
    requested_family = _requested_fontfamily(text)
    if requested_family.lower() in _TIMES_COMPAT_REQUESTS:
        _set_text_fontfamily(text, requested_family)


def _normalise_runtime_fonts(raw_elements: list[tuple[str, str, Any]]):
    seen: set[int] = set()
    for _, kind, artist in raw_elements:
        if kind != "text" or artist is None or id(artist) in seen:
            continue
        seen.add(id(artist))
        _normalise_text_runtime_font(artist)


def _snapshot_text_style(text):
    return {
        "fontsize": text.get_fontsize(),
        "fontname": text.get_fontname(),
        "requested_fontfamily": getattr(text, "_scifigure_requested_fontfamily", None),
        "color": text.get_color(),
        "rotation": text.get_rotation(),
        "ha": text.get_horizontalalignment(),
        "va": text.get_verticalalignment(),
        "visible": text.get_visible(),
        "fontweight": text.get_fontweight(),
        "fontstyle": text.get_fontstyle(),
    }


def _restore_text_style(text, style: dict):
    try:
        text.set_fontsize(style["fontsize"])
        if style.get("requested_fontfamily"):
            _set_text_fontfamily(text, style["requested_fontfamily"])
        else:
            text.set_fontname(style["fontname"])
        text.set_color(style["color"])
        text.set_rotation(style["rotation"])
        text.set_horizontalalignment(style["ha"])
        text.set_verticalalignment(style["va"])
        text.set_visible(style["visible"])
        text.set_fontweight(style.get("fontweight", "normal"))
        text.set_fontstyle(style.get("fontstyle", "normal"))
    except Exception:
        pass


def _get_tick_label_offset(axis) -> tuple[float, float]:
    return (
        float(getattr(axis, "_scifigure_tick_label_dx", 0.0) or 0.0),
        float(getattr(axis, "_scifigure_tick_label_dy", 0.0) or 0.0),
    )


def _get_tick_label_text_overrides(axis) -> dict[int, str]:
    overrides = getattr(axis, "_scifigure_tick_label_text_overrides", None)
    if not isinstance(overrides, dict):
        overrides = {}
        setattr(axis, "_scifigure_tick_label_text_overrides", overrides)
    return overrides


def _set_tick_label_text_override(artist, gid: str, value: Any) -> bool:
    match = re.match(r"^(x|y)tick\.(\d+)\.(\d+)$", gid or "")
    if not match:
        return False
    ax = getattr(artist, "axes", None)
    if ax is None:
        fig = getattr(artist, "figure", None)
        axes = getattr(fig, "axes", []) if fig is not None else []
        ax_idx = int(match.group(2))
        if 0 <= ax_idx < len(axes):
            ax = axes[ax_idx]
    if ax is None:
        return False
    axis = ax.xaxis if match.group(1) == "x" else ax.yaxis
    index = int(match.group(3))
    overrides = _get_tick_label_text_overrides(axis)
    overrides[index] = str(value)
    try:
        artist.set_text(str(value))
    except Exception:
        pass
    return True


def _apply_tick_label_offset(axis, axis_name: str):
    """Shift tick label text in points without moving ticks or data limits."""
    try:
        from matplotlib.transforms import ScaledTranslation

        dx, dy = _get_tick_label_offset(axis)
        fig = axis.axes.figure if axis.axes is not None else None
        if fig is None:
            return
        offset = ScaledTranslation(dx / 72.0, dy / 72.0, fig.dpi_scale_trans)
        for label in axis.get_ticklabels():
            base = getattr(label, "_scifigure_base_transform", None)
            if base is None or getattr(label, "_scifigure_offset_axis_name", None) != axis_name:
                base = label.get_transform()
                setattr(label, "_scifigure_base_transform", base)
                setattr(label, "_scifigure_offset_axis_name", axis_name)
            label.set_transform(base + offset)
    except Exception:
        pass


def _freeze_ticklabels_preserving_style(ax):
    """Materialize tick labels without discarding prior UI-applied font edits."""
    original_xlim = ax.get_xlim()
    original_ylim = ax.get_ylim()
    try:
        ax.figure.canvas.draw()
    except Exception:
        pass

    for axis_name in ("x", "y"):
        axis = ax.xaxis if axis_name == "x" else ax.yaxis
        if axis.get_scale() not in ("linear", "log"):
            continue

        get_ticks = ax.get_xticks if axis_name == "x" else ax.get_yticks
        get_labels = ax.get_xticklabels if axis_name == "x" else ax.get_yticklabels
        set_ticks = ax.set_xticks if axis_name == "x" else ax.set_yticks
        set_labels = ax.set_xticklabels if axis_name == "x" else ax.set_yticklabels

        labels = list(get_labels())
        texts = [label.get_text() for label in labels]
        text_overrides = _get_tick_label_text_overrides(axis)
        for idx, override_text in text_overrides.items():
            if 0 <= idx < len(texts):
                texts[idx] = override_text
        styles = [_snapshot_text_style(label) for label in labels]
        set_ticks(get_ticks())
        next_labels = set_labels(texts)
        if not next_labels:
            next_labels = list(get_labels())
        for label, style in zip(next_labels, styles):
            _restore_text_style(label, style)
        _apply_tick_label_offset(axis, axis_name)

    # Matplotlib intentionally expands view limits when set_ticks() receives
    # ticks outside the current limits.  That breaks user-applied xlim/ylim
    # patches during introspection, so restore the exact limits after freezing
    # tick labels.
    try:
        ax.set_xlim(original_xlim)
        ax.set_ylim(original_ylim)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Property readers  (artist → plain dict)
# ---------------------------------------------------------------------------

def _get_text_coord_system(artist) -> str:
    try:
        from matplotlib.text import Annotation
        if isinstance(artist, Annotation):
            anncoords = getattr(artist, "anncoords", None)
            if anncoords == "data":
                return "data"
            if anncoords in {"axes fraction", "axes"}:
                return "axes"
            if anncoords in {"figure fraction", "figure"}:
                return "figure"
            return "native"
    except Exception:
        pass

    axis_label = _axis_label_context(artist)
    if axis_label is not None:
        return "axes"

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


def _axis_label_context(artist):
    fig = getattr(artist, "figure", None)
    if fig is None:
        return None
    for ax in getattr(fig, "axes", []):
        if artist is ax.xaxis.label:
            return ax, ax.xaxis
        if artist is ax.yaxis.label:
            return ax, ax.yaxis
    return None


def _axes_title_context(artist):
    fig = getattr(artist, "figure", None)
    if fig is None:
        return None
    for ax in getattr(fig, "axes", []):
        if artist is ax.title:
            return ax, "center"
        if artist is getattr(ax, "_left_title", None):
            return ax, "left"
        if artist is getattr(ax, "_right_title", None):
            return ax, "right"
    return None


def _annotation_coord_system(value: Any) -> str:
    if not isinstance(value, str):
        return "native"
    if value == "data":
        return "data"
    if value in {"axes fraction", "axes"}:
        return "axes"
    if value in {"figure fraction", "figure"}:
        return "figure"
    return "native"


def _matplotlib_annotation_coord(value: str) -> Optional[str]:
    if value == "data":
        return "data"
    if value == "axes":
        return "axes fraction"
    if value == "figure":
        return "figure fraction"
    return None

def _read_text_props(artist) -> dict:
    x, y = artist.get_position()
    axis_label = _axis_label_context(artist)
    axes_title = _axes_title_context(artist)
    managed_axes = axis_label[0] if axis_label is not None else axes_title[0] if axes_title is not None else None
    if managed_axes is not None:
        try:
            display_position = artist.get_transform().transform((x, y))
            x, y = managed_axes.transAxes.inverted().transform(display_position)
        except Exception:
            pass
    
    from matplotlib import colors as mcolors
    def to_hex_safe(c):
        try:
            return mcolors.to_hex(c, keep_alpha=False)
        except Exception:
            return "#000000"

    props = {
        "text": artist.get_text(),
        "fontsize": artist.get_fontsize(),
        "color": to_hex_safe(artist.get_color()),
        "fontfamily": _requested_fontfamily(artist),
        "resolvedFontfamily": _actual_fontfamily(artist),
        "fontweight": artist.get_fontweight(),
        "fontstyle": artist.get_fontstyle(),
        "x": float(x),
        "y": float(y),
        "coord_system": _get_text_coord_system(artist),
        "ha": artist.get_horizontalalignment(),
        "va": artist.get_verticalalignment(),
        "rotation": float(artist.get_rotation()),
    }
    try:
        from matplotlib.text import Annotation
        if isinstance(artist, Annotation):
            anchor_x, anchor_y = artist.xy
            props.update({
                "is_annotation": True,
                "anchor_x": float(anchor_x),
                "anchor_y": float(anchor_y),
                "anchor_coord_system": _annotation_coord_system(getattr(artist, "xycoords", None)),
                "anchor_position": {
                    "x": float(anchor_x),
                    "y": float(anchor_y),
                    "coord_system": _annotation_coord_system(getattr(artist, "xycoords", None)),
                },
                "has_arrow": artist.arrow_patch is not None,
            })
    except Exception:
        pass
    return props


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

    position = {"x": None, "y": None, "coord_system": "figure"}
    try:
        fig = artist.figure
        if fig is not None and fig.canvas is not None:
            fig.canvas.draw()
            bbox = artist.get_window_extent(fig.canvas.get_renderer()).transformed(fig.transFigure.inverted())
            position = {
                "x": float((bbox.x0 + bbox.x1) / 2),
                "y": float((bbox.y0 + bbox.y1) / 2),
                "coord_system": "figure",
            }
    except Exception:
        pass
            
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
        "marker_yoffset": getattr(artist, "_scifigure_marker_yoffset", 0.0) or 0.0,
        "handletextpad": getattr(artist, "handletextpad", 0.8),
        "labelspacing": getattr(artist, "labelspacing", 0.5),
        "handlelength": getattr(artist, "handlelength", 2.0),
        "handleheight": getattr(artist, "handleheight", 0.7),
        "columnspacing": getattr(artist, "columnspacing", 2.0),
        "borderpad": getattr(artist, "borderpad", 0.4),
        "borderaxespad": getattr(artist, "borderaxespad", 0.5),
        "title": artist.get_title().get_text() if artist.get_title() is not None else "",
        "fontfamily": _requested_fontfamily(artist.get_texts()[0]) if artist.get_texts() else "",
        "resolvedFontfamily": _actual_fontfamily(artist.get_texts()[0]) if artist.get_texts() else "",
        "fontweight": artist.get_texts()[0].get_fontweight() if artist.get_texts() else "normal",
        "fontstyle": artist.get_texts()[0].get_fontstyle() if artist.get_texts() else "normal",
        "x": position["x"],
        "y": position["y"],
        "coord_system": position["coord_system"],
    }


def _read_line_props(artist) -> dict:
    return {
        "color": artist.get_color(),
        "linewidth": artist.get_linewidth(),
        "linestyle": artist.get_linestyle(),
        "alpha": artist.get_alpha(),
        "marker": artist.get_marker(),
        "markersize": artist.get_markersize(),
    }


def _read_collection_props(artist) -> dict:
    fc = artist.get_facecolor()
    ec = artist.get_edgecolor()
    linewidths = []
    try:
        linewidths = artist.get_linewidths()
    except Exception:
        linewidths = []
    linewidth = None
    try:
        if len(linewidths) > 0:
            linewidth = float(linewidths[0])
    except Exception:
        linewidth = None
    size = None
    sizes_list = []
    try:
        sizes = artist.get_sizes()
        if len(sizes) > 0:
            sizes_list = [float(item) for item in sizes]
            size = float(sizes[0])
    except Exception:
        size = None
    return {
        "facecolor": fc.tolist() if hasattr(fc, "tolist") else fc,
        "edgecolor": ec.tolist() if hasattr(ec, "tolist") else ec,
        "alpha": artist.get_alpha(),
        "linewidth": linewidth,
        "size": size,
        "sizes": sizes_list,
        "size_scale": 1.0,
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


def _is_colorbar_axes(ax) -> bool:
    """Matplotlib stores colorbars as Axes; don't expose them as data subplots."""
    return bool(getattr(ax, "_colorbar", None) is not None or getattr(ax, "_colorbar_info", None) is not None)


def _read_subplot_props(artist) -> dict:
    bounds = artist.get_position().bounds
    try:
        aspect = artist.get_aspect()
    except Exception:
        aspect = "auto"
    if isinstance(aspect, (int, float)) and abs(float(aspect) - 1.0) < 1e-9:
        aspect = "1"
    return {
        "left": float(bounds[0]),
        "bottom": float(bounds[1]),
        "width": float(bounds[2]),
        "height": float(bounds[3]),
        "aspect": str(aspect),
    }


def _build_subplot_layout_meta(raw_elements: list[tuple[str, str, Any]]) -> dict[str, dict[str, Any]]:
    subplot_items = []
    for gid, kind, ax in raw_elements:
        if kind != "subplot":
            continue
        bounds = ax.get_position().bounds
        subplot_items.append({
            "gid": gid,
            "left": float(bounds[0]),
            "bottom": float(bounds[1]),
            "width": float(bounds[2]),
            "height": float(bounds[3]),
            "center_x": float(bounds[0] + bounds[2] / 2),
            "center_y": float(bounds[1] + bounds[3] / 2),
        })
    if not subplot_items:
        return {}

    def assign_groups(values: list[float], tolerance: float = 0.035, reverse: bool = False) -> dict[float, int]:
        ordered = sorted(values, reverse=reverse)
        groups: list[float] = []
        result: dict[float, int] = {}
        for value in ordered:
            matched = None
            for idx, center in enumerate(groups):
                if abs(value - center) <= tolerance:
                    matched = idx
                    break
            if matched is None:
                groups.append(value)
                matched = len(groups) - 1
            result[value] = matched
        return result

    row_by_y = assign_groups([item["center_y"] for item in subplot_items], reverse=True)
    col_by_x = assign_groups([item["center_x"] for item in subplot_items], reverse=False)
    ordered = sorted(subplot_items, key=lambda item: (row_by_y[item["center_y"]], col_by_x[item["center_x"]], item["left"]))

    meta: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(ordered):
        row = row_by_y[item["center_y"]]
        col = col_by_x[item["center_x"]]
        meta[item["gid"]] = {
            "subplotIndex": index,
            "row": row,
            "col": col,
            "label": f"子图 {index + 1} (第 {row + 1} 行，第 {col + 1} 列)",
        }
    return meta


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
    tick_label_color = labels[0].get_color() if labels else "#000000"
    try:
        tick_label_color = mcolors.to_hex(tick_label_color, keep_alpha=False)
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
        "tick_labelcolor": tick_label_color,
        "tick_labelfamily": _requested_fontfamily(labels[0]) if labels else "",
        "resolvedTickLabelfamily": _actual_fontfamily(labels[0]) if labels else "",
        "resolvedFontfamily": _actual_fontfamily(labels[0]) if labels else "",
        "tick_fontweight": labels[0].get_fontweight() if labels else "normal",
        "tick_fontstyle": labels[0].get_fontstyle() if labels else "normal",
        "tick_label_dx": _get_tick_label_offset(axis)[0],
        "tick_label_dy": _get_tick_label_offset(axis)[1],
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


def _read_bar_container_props(container) -> dict:
    children = container.get_children()
    if not children:
        return {}
    first = children[0]
    return _read_patch_props(first)


def _read_errorbar_container_props(container) -> dict:
    lines = container.lines
    data_line = lines[0]
    cap_lines = lines[1]
    bar_cols = lines[2]
    
    props = {}
    
    # Color
    color = None
    if data_line is not None:
        color = data_line.get_color()
    elif bar_cols:
        color = bar_cols[0].get_color()
    if color is not None:
        try:
            from matplotlib import colors as mcolors
            if hasattr(color, "ndim") and color.ndim > 1:
                color = color[0]
            color = mcolors.to_hex(color, keep_alpha=False)
        except Exception:
            pass
        props["color"] = color
        
    # Linewidth
    if data_line is not None:
        props["linewidth"] = data_line.get_linewidth()
        
    # Elinewidth
    if bar_cols:
        try:
            lws = bar_cols[0].get_linewidths()
            if len(lws) > 0:
                props["elinewidth"] = float(lws[0])
        except Exception:
            pass
            
    # Capthick
    if cap_lines:
        props["capthick"] = cap_lines[0].get_linewidth()
        props["capsize"] = cap_lines[0].get_markersize() / 2.0
        
    # Alpha
    if data_line is not None:
        props["alpha"] = data_line.get_alpha()
    elif bar_cols:
        props["alpha"] = bar_cols[0].get_alpha()
        
    # Marker & Markersize
    if data_line is not None:
        props["marker"] = data_line.get_marker()
        props["markersize"] = data_line.get_markersize()
        
    return props


def _read_boxplot_container_props(container) -> dict:
    bp = container.bp_dict
    props = {}

    def _artist_color_hex(artist, preferred: str = "color", fallback: str = "#000000") -> str:
        from matplotlib import colors as mcolors
        getters = []
        if preferred == "facecolor":
            getters = ["get_facecolor", "get_color", "get_edgecolor"]
        elif preferred == "edgecolor":
            getters = ["get_edgecolor", "get_color", "get_facecolor"]
        else:
            getters = ["get_color", "get_edgecolor", "get_facecolor"]
        for getter_name in getters:
            getter = getattr(artist, getter_name, None)
            if getter is None:
                continue
            try:
                value = getter()
                if hasattr(value, "ndim") and value.ndim > 1 and len(value) > 0:
                    value = value[0]
                return mcolors.to_hex(value, keep_alpha=False)
            except Exception:
                continue
        return fallback
    
    # Color
    color = None
    if bp.get("boxes"):
        color = _artist_color_hex(bp["boxes"][0], "edgecolor")
    elif bp.get("medians"):
        color = _artist_color_hex(bp["medians"][0], "color")
    if color is not None:
        props["color"] = color
        
    # Linewidth
    if bp.get("boxes"):
        props["linewidth"] = bp["boxes"][0].get_linewidth()
        
    # Alpha
    if bp.get("boxes"):
        props["alpha"] = bp["boxes"][0].get_alpha()
        
    # Box Color
    if bp.get("boxes"):
        props["box_color"] = _artist_color_hex(bp["boxes"][0], "facecolor")
        
    # Median Color
    if bp.get("medians"):
        props["median_color"] = _artist_color_hex(bp["medians"][0], "color")
        
    return props


def _read_stem_container_props(container) -> dict:
    from matplotlib import colors as mcolors

    markerline = getattr(container, "markerline", None)
    stemlines = getattr(container, "stemlines", None)
    baseline = getattr(container, "baseline", None)
    props = {}

    def color_hex(value, fallback=None):
        try:
            if hasattr(value, "ndim") and value.ndim > 1 and len(value) > 0:
                value = value[0]
            return mcolors.to_hex(value, keep_alpha=False)
        except Exception:
            return fallback

    if markerline is not None:
        props["marker"] = markerline.get_marker()
        props["markersize"] = float(markerline.get_markersize())
        props["marker_color"] = color_hex(markerline.get_color(), "#000000")
        props["alpha"] = markerline.get_alpha()
    if stemlines is not None:
        colors = stemlines.get_colors() if hasattr(stemlines, "get_colors") else []
        linewidths = stemlines.get_linewidths() if hasattr(stemlines, "get_linewidths") else []
        if len(colors) > 0:
            props["stem_color"] = color_hex(colors[0], "#000000")
            props.setdefault("color", props["stem_color"])
        if len(linewidths) > 0:
            props["stem_linewidth"] = float(linewidths[0])
    if baseline is not None:
        props["baseline_color"] = color_hex(baseline.get_color(), "#000000")
        props["baseline_linewidth"] = float(baseline.get_linewidth())
        props["baseline_visible"] = bool(baseline.get_visible())
    return props


def _read_violinplot_container_props(container) -> dict:
    vp = container.vp_dict
    props = {}
    bodies = vp.get("bodies", [])
    if bodies:
        props.update(_read_collection_props(bodies[0]))
    return props


def _read_heatmap_props(artist) -> dict:
    from matplotlib.collections import QuadMesh
    props = {}
    
    # Check if this is an RGB/RGBA image
    is_rgb = False
    if hasattr(artist, "get_array"):
        try:
            arr = artist.get_array()
            if arr is not None and len(arr.shape) == 3:
                is_rgb = True
        except Exception:
            pass

    try:
        props["cmap"] = (artist.cmap.name if hasattr(artist, "cmap") and artist.cmap else None) if not is_rgb else None
    except Exception:
        props["cmap"] = None

    try:
        clim = artist.get_clim() if hasattr(artist, "get_clim") else (None, None)
        props["vmin"] = (float(clim[0]) if clim[0] is not None else None) if not is_rgb else None
        props["vmax"] = (float(clim[1]) if clim[1] is not None else None) if not is_rgb else None
    except Exception:
        props["vmin"] = None
        props["vmax"] = None

    try:
        props["alpha"] = float(artist.get_alpha()) if hasattr(artist, "get_alpha") and artist.get_alpha() is not None else None
    except Exception:
        props["alpha"] = None

    # Shape
    try:
        if isinstance(artist, QuadMesh):
            coords = artist.get_coordinates()
            props["shape"] = [coords.shape[0] - 1, coords.shape[1] - 1]
        elif hasattr(artist, "get_array"):
            props["shape"] = list(artist.get_array().shape)
        else:
            props["shape"] = None
    except Exception:
        try:
            props["shape"] = list(artist.get_array().shape) if hasattr(artist, "get_array") else None
        except Exception:
            props["shape"] = None

    # Extent
    if hasattr(artist, "get_extent"):
        try:
            props["extent"] = [float(x) for x in artist.get_extent()]
        except Exception:
            props["extent"] = None
    else:
        props["extent"] = None

    # Interpolation
    if hasattr(artist, "get_interpolation"):
        try:
            props["interpolation"] = artist.get_interpolation()
        except Exception:
            props["interpolation"] = None
    else:
        props["interpolation"] = None

    return props


def _read_colorbar_props(cbar) -> dict:
    orientation = getattr(cbar, "orientation", "vertical")
    
    # Label
    label = ""
    try:
        if orientation == "vertical":
            label = cbar.ax.yaxis.get_label().get_text()
        else:
            label = cbar.ax.xaxis.get_label().get_text()
    except Exception:
        pass

    # Tick Fontsize
    tick_fontsize = 10
    try:
        ticks = cbar.ax.yaxis.get_ticklabels() if orientation == "vertical" else cbar.ax.xaxis.get_ticklabels()
        if ticks:
            tick_fontsize = float(ticks[0].get_size())
    except Exception:
        pass

    # VMin, VMax, CMap from mappable
    vmin, vmax, cmap = None, None, None
    if getattr(cbar, "mappable", None) is not None:
        try:
            clim = cbar.mappable.get_clim()
            vmin = float(clim[0]) if clim[0] is not None else None
            vmax = float(clim[1]) if clim[1] is not None else None
            cmap = cbar.mappable.cmap.name
        except Exception:
            pass

    visible = True
    try:
        visible = bool(cbar.ax.get_visible())
    except Exception:
        pass

    left, bottom, width, height = 0.0, 0.0, 0.0, 0.0
    try:
        bounds = cbar.ax.get_position().bounds  # [x0, y0, w, h]
        left = float(bounds[0])
        bottom = float(bounds[1])
        width = float(bounds[2])
        height = float(bounds[3])
    except Exception:
        pass

    return {
        "label": label,
        "tick_fontsize": tick_fontsize,
        "orientation": orientation,
        "vmin": vmin,
        "vmax": vmax,
        "cmap": cmap,
        "visible": visible,
        "left": left,
        "bottom": bottom,
        "width": width,
        "height": height,
    }


_READERS = {
    "text": _read_text_props,
    "subplot": _read_subplot_props,
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
    "bar_container": _read_bar_container_props,
    "errorbar_container": _read_errorbar_container_props,
    "stem_container": _read_stem_container_props,
    "boxplot_container": _read_boxplot_container_props,
    "violinplot_container": _read_violinplot_container_props,
    "heatmap": _read_heatmap_props,
    "colorbar": _read_colorbar_props,
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
    "text": ["text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "ha", "va", "rotation", "position", "zorder"],
    "subplot": ["left", "bottom", "width", "height", "aspect", "zorder"],
    "spine": ["visible", "color", "linewidth", "zorder"],
    "spine_group": ["visible", "color", "linewidth", "zorder"],
    "legend": ["visible", "fontsize", "frameon", "facecolor", "edgecolor", "linewidth", "alpha", "loc", "ncol", "markerscale", "marker_yoffset", "handletextpad", "labelspacing", "handlelength", "handleheight", "columnspacing", "borderpad", "borderaxespad", "title", "fontfamily", "fontweight", "fontstyle", "position", "zorder"],
    "line": ["color", "linewidth", "linestyle", "alpha", "marker", "markersize", "zorder"],
    "patch": ["facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
    "collection": ["facecolor", "edgecolor", "alpha", "linewidth", "size", "size_scale", "zorder"],
    "axes": ["xlim", "ylim", "show_minor_ticks", "x_tick_rotation", "tick_direction", "zorder"],
    "grid": ["visible", "color", "linewidth", "linestyle", "alpha", "zorder"],
    "axis_x": ["limits", "label", "label_fontsize", "label_color", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad", "minor_tick_length", "minor_tick_width", "minor_tick_color", "show_minor_ticks", "tick_labelsize", "tick_labelcolor", "tick_labelfamily", "tick_fontweight", "tick_fontstyle", "tick_label_dx", "tick_label_dy", "sci_notation", "use_math_text", "offset_text_size"],
    "axis_y": ["limits", "label", "label_fontsize", "label_color", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad", "minor_tick_length", "minor_tick_width", "minor_tick_color", "show_minor_ticks", "tick_labelsize", "tick_labelcolor", "tick_labelfamily", "tick_fontweight", "tick_fontstyle", "tick_label_dx", "tick_label_dy", "sci_notation", "use_math_text", "offset_text_size"],
    "bar_container": ["color", "facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
    "errorbar_container": ["color", "linewidth", "elinewidth", "capsize", "capthick", "alpha", "marker", "markersize", "zorder"],
    "stem_container": ["color", "stem_color", "stem_linewidth", "marker", "marker_color", "markersize", "baseline_color", "baseline_linewidth", "baseline_visible", "alpha"],
    "boxplot_container": ["color", "linewidth", "alpha", "box_color", "median_color", "zorder"],
    "violinplot_container": ["color", "facecolor", "edgecolor", "linewidth", "alpha", "zorder"],
    "heatmap": ["cmap", "vmin", "vmax", "alpha"],
    "colorbar": ["label", "tick_fontsize", "visible", "left", "bottom", "width", "height"],
}


def _get_editable(kind: str) -> list:
    return _EDITABLE.get(kind, [])


def _determine_role(gid: str, parent_kind: Optional[str] = None) -> Optional[str]:
    if gid.startswith("subplot."):
        return "subplot_panel"
    if gid.startswith("fig_text."):
        return "figure_title"
    if gid.startswith("title.left.") or gid.startswith("title.right.") or gid.startswith("title."):
        return "axes_title"
    if gid.startswith("xlabel."):
        return "x_axis_label"
    if gid.startswith("ylabel."):
        return "y_axis_label"
    if gid.startswith("xtick."):
        return "x_tick_label"
    if gid.startswith("ytick."):
        return "y_tick_label"
    if gid.startswith("legend."):
        return "legend"
    if gid.startswith("legend_title.") or gid.startswith("legend_text."):
        return "legend_text"
    if gid.startswith("legend_line.") or gid.startswith("legend_patch.") or gid.startswith("legend_collection."):
        return "legend_marker"
    if gid.startswith("spine_group."):
        return "axis_frame"
    if gid.startswith("spine."):
        return "spine"
    if gid.startswith("grid."):
        return "grid"
    if gid.startswith("container.bar."):
        return "bar_series"
    if gid.startswith("container.errorbar."):
        return "errorbar_series"
    if gid.startswith("container.stem."):
        return "stem_series"
    if gid.startswith("container.boxplot."):
        return "boxplot_group"
    if gid.startswith("container.violinplot."):
        return "violin_group"
        
    if parent_kind == "bar_container":
        return "bar_series"
    if parent_kind == "errorbar_container":
        return "errorbar_series"
    if parent_kind == "stem_container":
        return "stem_series"
    if parent_kind == "boxplot_container":
        return "boxplot_group"
    if parent_kind == "violinplot_container":
        return "violin_group"
        
    if gid.startswith("line."):
        return "line_series"
    if gid.startswith("collection."):
        return "scatter_series"
    if gid.startswith("patch."):
        return "bar_series"
    if gid.startswith("heatmap."):
        return "heatmap_series"
    if gid.startswith("colorbar."):
        return "colorbar"
    if gid.startswith("annotation_arrow."):
        return "annotation_arrow"
        
    return None


def _generate_stable_key_and_fingerprint(obj: dict, artist: Any, ax_idx: int) -> tuple[str, str]:
    kind = obj["kind"]
    gid = obj["id"]
    label = obj.get("label") or ""
    
    clean_label = ""
    if label and not label.startswith("_") and not label.startswith("line.") and not label.startswith("patch.") and not label.startswith("collection."):
        clean_label = label
        
    parts = [f"ax{ax_idx}", kind]
    if clean_label:
        parts.append(f"label.{clean_label}")
    else:
        match = re.search(r'\.(\d+)$', gid)
        if match:
            parts.append(f"idx.{match.group(1)}")
            
    stable_key = ".".join(parts)
    
    fp_parts = [stable_key]
    if hasattr(artist, "get_xydata"):
        try:
            xy = artist.get_xydata()
            if xy is not None and xy.size > 0:
                fp_parts.append(f"data_shape.{xy.shape}")
                fp_parts.append(f"data_mean.{xy.mean():.4f}")
        except Exception:
            pass
            
    fp_parts.append(type(artist).__name__)
    for prop in ("color", "facecolor", "edgecolor", "linewidth", "linestyle", "fontsize"):
        val = obj.get("currentProps", {}).get(prop)
        if val is not None:
            fp_parts.append(f"{prop}.{val}")
            
    fp_str = "|".join(fp_parts)
    fingerprint = hashlib.sha256(fp_str.encode("utf-8")).hexdigest()
    
    return stable_key, fingerprint


_LOCAL_PREVIEW_PROPS = {
    "color", "facecolor", "edgecolor", "alpha", "visible"
}

_CROSS_FIGURE_UNSAFE_PROPS = {
    "text", "label", "title", "position", "left", "bottom", "width",
    "height", "limits", "aspect", "cmap", "vmin", "vmax"
}

_SERIES_KINDS = {
    "line", "collection", "patch", "bar_container", "errorbar_container",
    "stem_container", "boxplot_container", "violinplot_container", "heatmap"
}

_AXIS_TICK_TYPOGRAPHY_GROUP_PROPS = {
    "tick_labelsize",
    "tick_labelcolor",
    "tick_labelfamily",
    "tick_fontweight",
    "tick_fontstyle",
    "tick_rotation",
}


def _legend_container_gid(gid: str) -> Optional[str]:
    figure_match = re.match(
        r"^legend_(?:title|text|line|patch|collection)\.figure\.(\d+)", gid
    )
    if figure_match:
        return f"legend.figure.{figure_match.group(1)}"
    axes_match = re.match(
        r"^legend_(?:title|text|line|patch|collection)\.(\d+)", gid
    )
    if axes_match:
        return f"legend.{axes_match.group(1)}"
    return None


def _identity_coordinate_space(obj: dict) -> str:
    gid = obj.get("id", "")
    kind = obj.get("kind", "")
    coord_system = str(obj.get("currentProps", {}).get("coord_system") or "")
    if coord_system in {"data", "axes", "figure", "display"}:
        return coord_system
    if gid.startswith((
        "legend.", "legend_title.", "legend_text.", "legend_line.",
        "legend_patch.", "legend_collection."
    )):
        return "container"
    if kind in {"subplot", "colorbar"}:
        return "figure"
    if kind in {"line", "collection", "patch", "heatmap"}:
        return "data"
    if obj.get("subplotId"):
        return "axes"
    return "none"


def _is_figure_level_object(obj: dict) -> bool:
    gid = obj.get("id", "")
    return (
        obj.get("kind") == "figure"
        or gid.startswith("fig_text.")
        or gid.startswith("legend.figure.")
        or bool(re.match(
            r"^legend_(?:title|text|line|patch|collection)\.figure\.", gid
        ))
    )


def _build_object_identity(obj: dict) -> dict:
    gid = obj.get("id", "")
    kind = obj.get("kind", "component")
    role = obj.get("role") or kind
    figure_level = _is_figure_level_object(obj)
    relation = {}
    if obj.get("parentId"):
        relation["parentId"] = obj["parentId"]
    if obj.get("subplotId") and not figure_level:
        relation["subplotId"] = obj["subplotId"]
    if obj.get("subplotIds") and not figure_level:
        relation["subplotIds"] = list(obj["subplotIds"])
    legend_id = _legend_container_gid(gid)
    if legend_id:
        relation["legendId"] = legend_id
    if obj.get("legendTitleId"):
        relation["legendTitleId"] = obj["legendTitleId"]
    if obj.get("legendTextId"):
        relation["legendTextId"] = obj["legendTextId"]
    if obj.get("legendTextIds"):
        relation["legendTextIds"] = list(obj["legendTextIds"])
    if obj.get("legendMarkerIds"):
        relation["legendMarkerIds"] = list(obj["legendMarkerIds"])
    if obj.get("colorbarId"):
        relation["colorbarId"] = obj["colorbarId"]
    if obj.get("mappableId"):
        relation["mappableId"] = obj["mappableId"]
    if obj.get("mappableIds"):
        relation["mappableIds"] = list(obj["mappableIds"])
    if obj.get("annotationId"):
        relation["annotationId"] = obj["annotationId"]
    if obj.get("arrowId"):
        relation["arrowId"] = obj["arrowId"]
    if obj.get("textId"):
        relation["textId"] = obj["textId"]
    if obj.get("twinSubplotIds"):
        relation["twinSubplotIds"] = list(obj["twinSubplotIds"])
    if obj.get("sharedXSubplotIds"):
        relation["sharedXSubplotIds"] = list(obj["sharedXSubplotIds"])
    if obj.get("sharedYSubplotIds"):
        relation["sharedYSubplotIds"] = list(obj["sharedYSubplotIds"])

    shared_subplots = relation.get("subplotIds", [])
    scope = (
        "figure" if figure_level
        else "container" if legend_id or obj.get("_colorbarChild") or obj.get("parentId") or len(shared_subplots) > 1
        else "subplot"
    )
    semantic_suffix = relation.get("subplotId") or "+".join(shared_subplots) or "figure"
    if kind == "spine":
        side_match = re.match(r"^spine\.([^.]+)\.", gid)
        if side_match:
            semantic_suffix = f"{semantic_suffix}:{side_match.group(1)}"

    identity = {
        "semanticKey": f"{role}:{semantic_suffix}",
        "instanceKey": f"{scope}:{gid}",
        "scope": scope,
        "coordinateSpace": _identity_coordinate_space(obj),
    }
    if kind in _SERIES_KINDS and role != "annotation_arrow":
        identity["seriesKey"] = obj.get("stableKey") or f"{kind}:{gid}"
    if relation:
        identity["relation"] = relation
    return identity


def _property_derived_effects(prop: str) -> list[str]:
    if prop in {"text", "fontsize", "fontfamily", "fontweight", "fontstyle", "rotation"}:
        return ["text_bounds"]
    if prop == "position":
        return ["object_bounds"]
    if prop == "anchor_position":
        return ["annotation_arrow_geometry"]
    if prop in {"left", "bottom", "width", "height", "aspect"}:
        return ["child_display_position"]
    if prop in {
        "markerscale", "marker_yoffset", "handletextpad", "labelspacing",
        "handlelength", "handleheight", "columnspacing", "borderpad",
        "borderaxespad", "ncol",
    }:
        return ["container_layout"]
    return []


def _build_property_capabilities(obj: dict) -> list[dict]:
    identity = obj.get("identity", {})
    relation = identity.get("relation", {})
    capabilities = []
    for prop in obj.get("editable", []):
        scopes = ["object"]
        if obj.get("role") and prop not in {"position", "anchor_position"}:
            scopes.append("group")
        if obj.get("kind") in {"axis_x", "axis_y"} and prop in _AXIS_TICK_TYPOGRAPHY_GROUP_PROPS:
            scopes.append("group")
        if relation.get("subplotId"):
            scopes.append("subplot")
        if prop not in {"position", "left", "bottom", "width", "height"}:
            scopes.append("figure")
        if prop not in _CROSS_FIGURE_UNSAFE_PROPS:
            scopes.append("cross_figure")

        preview = "exact" if prop in _LOCAL_PREVIEW_PROPS else "none"
        replay = "stable"
        capability = {
            "prop": prop,
            "patchMode": (
                "backend_patch"
                if obj.get("kind") == "stem_container"
                else "local_patch" if prop in _LOCAL_PREVIEW_PROPS
                else "backend_patch"
            ),
            "scopes": list(dict.fromkeys(scopes)),
            "preview": preview,
            "replay": replay,
        }
        if obj.get("kind") == "stem_container":
            capability["preview"] = "none"
        if prop in {"position", "anchor_position"}:
            capability["preview"] = "approximate"
            capability["replay"] = "conditional"
            capability["coordinateSpace"] = (
                obj.get("currentProps", {}).get("anchor_coord_system", "none")
                if prop == "anchor_position"
                else identity.get("coordinateSpace", "none")
            )
        elif prop in {"left", "bottom", "width", "height"}:
            capability["coordinateSpace"] = "figure"
        elif prop == "aspect":
            capability["coordinateSpace"] = "container"
        derived_effects = _property_derived_effects(prop)
        if derived_effects:
            capability["derivedEffects"] = derived_effects
        capabilities.append(capability)
    return capabilities


# ---------------------------------------------------------------------------
# Kind from gid prefix
# ---------------------------------------------------------------------------

# (removed: kind is now yielded directly by iter_artists, not inferred from gid)


# ---------------------------------------------------------------------------
# Introspection entry point
# ---------------------------------------------------------------------------

def introspect_figure(fig, semantic_manifest=None) -> dict:
    """Accept a fully rendered Figure, return {svg, manifest}."""

    introspection_started = time.perf_counter()

    # 1. Bind gids and build initial artist-to-gid mapping
    artist_to_gid = {}
    raw_elements = []
    
    for gid, kind, artist in iter_artists(fig):
        if artist is None:
            continue
        if hasattr(artist, 'set_gid'):
            artist.set_gid(gid)
        artist_to_gid[artist] = gid
        raw_elements.append((gid, kind, artist))

    _normalise_runtime_fonts(raw_elements)

    subplot_meta = _build_subplot_layout_meta(raw_elements)

    # Colorbar Axes have their own figure index, which is not the subplot that
    # owns the data. Resolve ownership from Colorbar.mappable and preserve the
    # old gid/source axes index only as compatibility metadata.
    axes_to_subplot_gid = {
        artist: gid
        for gid, kind, artist in raw_elements
        if kind == "subplot"
    }
    subplot_relationships = {}
    for axes, subplot_gid in axes_to_subplot_gid.items():
        def related_subplot_ids(siblings):
            return sorted({
                axes_to_subplot_gid[sibling]
                for sibling in siblings
                if sibling is not axes and sibling in axes_to_subplot_gid
            })

        twinned_group = getattr(axes, "_twinned_axes", None)
        twin_axes = twinned_group.get_siblings(axes) if twinned_group is not None else []
        subplot_relationships[subplot_gid] = {
            "twinSubplotIds": related_subplot_ids(twin_axes),
            "sharedXSubplotIds": related_subplot_ids(axes.get_shared_x_axes().get_siblings(axes)),
            "sharedYSubplotIds": related_subplot_ids(axes.get_shared_y_axes().get_siblings(axes)),
        }
    colorbar_links = {}
    mappable_to_colorbars = {}
    annotation_links = {}
    for gid, kind, artist in raw_elements:
        if kind != "colorbar":
            continue
        mappable = getattr(artist, "mappable", None)
        mappable_gid = artist_to_gid.get(mappable)
        owner_axes = getattr(mappable, "axes", None) if mappable is not None else None
        owner_subplot_ids = []
        colorbar_axes = getattr(artist, "ax", None)
        colorbar_info = getattr(colorbar_axes, "_colorbar_info", {}) if colorbar_axes is not None else {}
        owner_axes_list = list(colorbar_info.get("parents", [])) if isinstance(colorbar_info, dict) else []
        for parent_axes in owner_axes_list:
            subplot_id = axes_to_subplot_gid.get(parent_axes)
            if subplot_id and subplot_id not in owner_subplot_ids:
                owner_subplot_ids.append(subplot_id)
        fallback_subplot_id = axes_to_subplot_gid.get(owner_axes)
        if not owner_subplot_ids and fallback_subplot_id:
            owner_subplot_ids.append(fallback_subplot_id)
            owner_axes_list.append(owner_axes)
        mappable_ids = [mappable_gid] if mappable_gid else []
        explicit_norm = getattr(mappable, "norm", None)
        explicit_cmap = getattr(getattr(mappable, "cmap", None), "name", None)
        for candidate_gid, candidate_kind, candidate in raw_elements:
            if candidate_gid == mappable_gid or candidate_kind not in {"heatmap", "collection"}:
                continue
            if getattr(candidate, "axes", None) not in owner_axes_list:
                continue
            candidate_cmap = getattr(getattr(candidate, "cmap", None), "name", None)
            if explicit_norm is not None and getattr(candidate, "norm", None) is explicit_norm and candidate_cmap == explicit_cmap:
                mappable_ids.append(candidate_gid)
        colorbar_links[gid] = {
            "mappableId": mappable_gid,
            "mappableIds": list(dict.fromkeys(mappable_ids)),
            "subplotId": owner_subplot_ids[0] if len(owner_subplot_ids) == 1 else None,
            "subplotIds": owner_subplot_ids,
        }
        for linked_mappable_gid in colorbar_links[gid]["mappableIds"]:
            mappable_to_colorbars.setdefault(linked_mappable_gid, []).append(gid)
    colorbar_axes_to_gid = {
        getattr(colorbar, "ax", None): colorbar_gid
        for colorbar_gid, kind, colorbar in raw_elements
        if kind == "colorbar" and getattr(colorbar, "ax", None) is not None
    }
    for gid, kind, artist in raw_elements:
        if kind != "text":
            continue
        try:
            from matplotlib.text import Annotation
            if not isinstance(artist, Annotation):
                continue
            arrow_gid = artist_to_gid.get(artist.arrow_patch) if artist.arrow_patch is not None else None
            annotation_links[gid] = {
                "role": "annotation_text",
                "annotationId": gid,
                "arrowId": arrow_gid,
            }
            if arrow_gid:
                annotation_links[arrow_gid] = {
                    "role": "annotation_arrow",
                    "annotationId": gid,
                    "textId": gid,
                }
        except Exception:
            continue

    legend_relationships = {}
    for legend_gid, kind, legend in raw_elements:
        if kind != "legend":
            continue
        title_gid = artist_to_gid.get(legend.get_title())
        text_gids = [artist_to_gid.get(text) for text in legend.get_texts()]
        handles = _get_legend_handles(legend)
        marker_gids = [artist_to_gid.get(handle) for handle in handles]
        legend_relationships[legend_gid] = {
            "legendTitleId": title_gid,
            "legendTextIds": [child_gid for child_gid in text_gids if child_gid],
            "legendMarkerIds": [child_gid for child_gid in marker_gids if child_gid],
        }
        for entry_index, text_gid in enumerate(text_gids):
            marker_gid = marker_gids[entry_index] if entry_index < len(marker_gids) else None
            if text_gid and marker_gid:
                legend_relationships.setdefault(text_gid, {})["legendMarkerIds"] = [marker_gid]
                legend_relationships.setdefault(marker_gid, {})["legendTextId"] = text_gid

    # Build objects manifest list
    objects = []
    for gid, kind, artist in raw_elements:
        if kind == "grid_line":
            continue
        current_props = _read_props(artist, kind)
        label = _safe_artist_label(artist, gid)
        if kind == "subplot":
            meta = subplot_meta.get(gid, {})
            label = meta.get("label", label)
            current_props = {
                **current_props,
                "subplotIndex": meta.get("subplotIndex", 0),
                "row": meta.get("row", 0),
                "col": meta.get("col", 0),
                "label": label,
            }
        editable = _get_editable(kind)
        annotation_link = annotation_links.get(gid)
        if annotation_link and annotation_link.get("role") == "annotation_text":
            anchor_coord_system = current_props.get("anchor_coord_system")
            if anchor_coord_system in {"data", "axes", "figure"}:
                editable = [*editable, "anchor_position"]
            else:
                current_props = {
                    **current_props,
                    "anchorPositionEditable": False,
                    "anchorPositionUnsupportedReason": "This annotation anchor uses a non-linear or callable coordinate system.",
                }
        if gid.startswith(("xtick.", "ytick.")):
            # Tick labels are owned by Matplotlib's axis/tick layout engine.
            # Free-position patches are visually previewable in SVG but are not
            # stable after replay/render; use axis tick_pad/rotation instead.
            editable = [prop for prop in editable if prop != "position"]
            current_props = {
                **current_props,
                "positionEditable": False,
                "positionUnsupportedReason": "Tick labels are controlled by the axis layout engine; adjust tick_pad, rotation, font size, or subplot bounds instead.",
            }
        if gid.startswith(("legend_text.", "legend_title.")):
            # Legend child artists are laid out by the Legend container.
            # Moving them independently detaches text from legend handles after replay.
            editable = [prop for prop in editable if prop != "position"]
            current_props = {
                **current_props,
                "positionEditable": False,
                "positionUnsupportedReason": "Legend text is controlled by the legend container; move legend.* instead.",
            }
        if kind == "text" and current_props.get("coord_system") not in {"axes", "figure", "data"}:
            editable = [prop for prop in editable if prop != "position"]
            current_props = {
                **current_props,
                "positionEditable": False,
                "positionUnsupportedReason": "This text uses a non-linear or offset coordinate system; move labels by editing source code or using a stable axes/data annotation.",
            }
        objects.append({
            "id": gid,
            "kind": kind,
            "label": label,
            "editable": editable,
            "currentProps": current_props,
        })

    # Build parent-child relationships
    child_to_parent = {}
    for gid, kind, artist in raw_elements:
        if kind in ("bar_container", "errorbar_container", "boxplot_container", "violinplot_container", "stem_container", "container"):
            children_gids = []
            if kind == "bar_container":
                for child in artist:
                    if child in artist_to_gid:
                        children_gids.append(artist_to_gid[child])
            elif kind in ("errorbar_container", "stem_container", "boxplot_container", "violinplot_container"):
                for child in artist.get_children():
                    if child in artist_to_gid:
                        children_gids.append(artist_to_gid[child])
            
            # Update container object in objects list
            container_obj = next((o for o in objects if o["id"] == gid), None)
            if container_obj:
                container_obj["children"] = children_gids
            
            for child_gid in children_gids:
                child_to_parent[child_gid] = (gid, kind)

    # Populate parentId, role, source, stableKey, and fingerprint for each object
    for obj in objects:
        gid = obj["id"]
        kind = obj["kind"]
        
        # Link parent ID
        parent_info = child_to_parent.get(gid)
        parent_id = None
        parent_kind = None
        if parent_info:
            parent_id, parent_kind = parent_info
            obj["parentId"] = parent_id
            
        # Determine semantic role
        role = _determine_role(gid, parent_kind)
        annotation_link = annotation_links.get(gid)
        if annotation_link:
            role = annotation_link["role"]
            obj["annotationId"] = annotation_link.get("annotationId")
            if annotation_link.get("arrowId"):
                obj["arrowId"] = annotation_link["arrowId"]
            if annotation_link.get("textId"):
                obj["textId"] = annotation_link["textId"]
        if role:
            obj["role"] = role

        for relation_name, relation_value in legend_relationships.get(gid, {}).items():
            if relation_value:
                obj[relation_name] = relation_value
            
        # Extract axes index from gid or container parts
        ax_idx = 0
        match = re.search(r'\.(\d+)(?:\.\d+)?$', gid)
        if match:
            try:
                ax_idx = int(match.group(1))
            except ValueError:
                pass
        if gid.startswith("container."):
            parts = gid.split(".")
            if len(parts) >= 4:
                try:
                    ax_idx = int(parts[2])
                except ValueError:
                    pass

        artist_obj = next(art for g, k, art in raw_elements if g == gid)
        artist_axes = artist_obj if isinstance(artist_obj, Axes) else getattr(artist_obj, "axes", None)
        container_colorbar_gid = colorbar_axes_to_gid.get(artist_axes)
        colorbar_link = colorbar_links.get(gid)
        owner_colorbar_link = colorbar_link or colorbar_links.get(container_colorbar_gid)
        if colorbar_link:
            if colorbar_link.get("mappableId"):
                obj["mappableId"] = colorbar_link["mappableId"]
            if colorbar_link.get("mappableIds"):
                obj["mappableIds"] = colorbar_link["mappableIds"]
            if colorbar_link.get("subplotId"):
                obj["subplotId"] = colorbar_link["subplotId"]
            if colorbar_link.get("subplotIds"):
                obj["subplotIds"] = colorbar_link["subplotIds"]
        elif container_colorbar_gid:
            obj["colorbarId"] = container_colorbar_gid
            obj["_colorbarChild"] = True
            if owner_colorbar_link and owner_colorbar_link.get("subplotId"):
                obj["subplotId"] = owner_colorbar_link["subplotId"]
            if owner_colorbar_link and owner_colorbar_link.get("subplotIds"):
                obj["subplotIds"] = owner_colorbar_link["subplotIds"]
        elif kind != "figure" and not gid.startswith("fig_text."):
            obj["subplotId"] = f"subplot.{ax_idx}"

        if kind in {"subplot", "axes", "axis_x", "axis_y"}:
            for relation_name, related_ids in subplot_relationships.get(f"subplot.{ax_idx}", {}).items():
                if related_ids:
                    obj[relation_name] = related_ids

        linked_colorbars = mappable_to_colorbars.get(gid, [])
        if len(linked_colorbars) == 1:
            obj["colorbarId"] = linked_colorbars[0]

        # Add source metadata
        source_meta = {
            "artistClass": type(artist_obj).__name__,
            "axesIndex": ax_idx,
        }
        if owner_colorbar_link and owner_colorbar_link.get("subplotId"):
            owner_match = re.match(r"^subplot\.(\d+)$", owner_colorbar_link["subplotId"])
            if owner_match:
                source_meta["ownerAxesIndex"] = int(owner_match.group(1))
        if owner_colorbar_link and owner_colorbar_link.get("subplotIds"):
            owner_axes_indices = []
            for subplot_id in owner_colorbar_link["subplotIds"]:
                owner_match = re.match(r"^subplot\.(\d+)$", subplot_id)
                if owner_match:
                    owner_axes_indices.append(int(owner_match.group(1)))
            if owner_axes_indices:
                source_meta["ownerAxesIndices"] = owner_axes_indices
        if hasattr(artist_obj, "get_zorder"):
            try:
                source_meta["zorder"] = int(artist_obj.get_zorder())
            except Exception:
                pass
        obj["source"] = source_meta
        
        # Add stableKey and fingerprint
        stable_key, fingerprint = _generate_stable_key_and_fingerprint(obj, artist_obj, ax_idx)
        obj["stableKey"] = stable_key
        obj["fingerprint"] = fingerprint
        obj["identity"] = _build_object_identity(obj)
        obj.pop("colorbarId", None)
        obj.pop("_colorbarChild", None)
        obj.pop("mappableId", None)
        obj.pop("mappableIds", None)
        obj.pop("legendTitleId", None)
        obj.pop("legendTextId", None)
        obj.pop("legendTextIds", None)
        obj.pop("legendMarkerIds", None)
        obj.pop("annotationId", None)
        obj.pop("arrowId", None)
        obj.pop("textId", None)
        obj.pop("twinSubplotIds", None)
        obj.pop("sharedXSubplotIds", None)
        obj.pop("sharedYSubplotIds", None)
        obj["propertyCapabilities"] = _build_property_capabilities(obj)

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
    svg_serialize_started = time.perf_counter()
    fig.savefig(
        buf,
        format="svg",
        metadata={"Date": None},
    )
    svg = buf.getvalue().decode("utf-8")
    svg_serialize_ms = max(0, round((time.perf_counter() - svg_serialize_started) * 1000))

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

    # 4. Build dynamic coverage report
    all_artists = fig.findobj()
    recognized = set(art for g, k, art in raw_elements if art is not None)
    
    unsupported_map = {}
    for art in all_artists:
        if art in recognized:
            continue
        cls_name = type(art).__name__
        if cls_name in ("Figure", "AxesSubplot", "Axes", "XAxis", "YAxis", "CompositeGenericTransform", "Bbox", "TransformedBbox", "GridSpec"):
            continue
        unsupported_map[cls_name] = unsupported_map.get(cls_name, 0) + 1

    recognized_count = 0
    editable_count = 0
    readonly_count = 0
    by_kind = {}
    
    for obj in objects:
        recognized_count += 1
        kind = obj["kind"]
        editable_props = obj["editable"]
        if editable_props:
            editable_count += 1
        else:
            readonly_count += 1
            
        if kind not in by_kind:
            by_kind[kind] = {
                "count": 0,
                "editableProps": editable_props
            }
        by_kind[kind]["count"] += 1
        
    unsupported_artists = [
        {"class": cls, "count": count, "reason": f"Type {cls} is not currently supported for interactive editing"}
        for cls, count in unsupported_map.items()
    ]
    
    coverage_report = {
        "summary": {
            "recognized": recognized_count,
            "editable": editable_count,
            "readonly": readonly_count,
            "unsupported": sum(unsupported_map.values())
        },
        "byKind": by_kind,
        "unsupportedArtists": unsupported_artists
    }

    # 5. Build manifest
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
                "max": 1200,
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
        "coverageReport": coverage_report,
        "unsupportedNotes": [
            "数据排序逻辑仅可通过 code_patch 修改",
            "自定义 annotation 位置规则不可 live 编辑",
        ],
    }

    introspection_total_ms = max(0, round((time.perf_counter() - introspection_started) * 1000))
    return {
        "svg": svg,
        "manifest": manifest,
        "timingBreakdown": {
            "introspectionMs": max(0, introspection_total_ms - svg_serialize_ms),
            "svgSerializeMs": svg_serialize_ms,
            "totalMs": introspection_total_ms,
        },
    }



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


def _set_legend_loc(artist, loc: Any) -> None:
    setter = getattr(artist, "set_loc", None)
    if callable(setter):
        setter(loc)
        return
    reverse = {value: key for key, value in _LEGEND_LOC_MAP.items()}
    normalized = reverse.get(str(loc), loc)
    private_setter = getattr(artist, "_set_loc", None)
    if callable(private_setter):
        private_setter(normalized)
        return
    artist._loc = normalized


def _get_legend_handles(legend) -> list:
    """Return legend handle artists across Matplotlib versions."""
    handles = getattr(legend, "legend_handles", None)
    if handles is None:
        handles = getattr(legend, "legendHandles", None)
    if handles is None:
        handles = []
    result = list(handles)
    for handle in list(legend.get_lines()) + list(legend.get_patches()):
        if handle not in result:
            result.append(handle)
    return result


def _legend_markerfirst(legend) -> bool:
    try:
        from matplotlib.offsetbox import DrawingArea
        columns = legend._legend_handle_box.get_children()
        if not columns:
            return True
        entries = columns[0].get_children()
        if not entries:
            return True
        children = entries[0].get_children()
        return bool(children and isinstance(children[0], DrawingArea))
    except Exception:
        return True


def _capture_legend_layout(legend) -> dict:
    return {
        "handles": list(_get_legend_handles(legend)),
        "markerfirst": _legend_markerfirst(legend),
        "original_markerscale": float(getattr(legend, "markerscale", 1.0) or 1.0),
        "requested_handlelength": float(getattr(legend, "handlelength", 2.0) or 2.0),
        "requested_handleheight": float(getattr(legend, "handleheight", 0.7) or 0.7),
        "requested_borderpad": float(getattr(legend, "borderpad", 0.4) or 0.4),
    }


def _normalized_legend_source_handle(handle, original_scale: float):
    try:
        source = copy.copy(handle)
    except Exception:
        source = handle
    safe_scale = original_scale if original_scale > 0 else 1.0
    try:
        marker = source.get_marker() if hasattr(source, "get_marker") else None
        if marker not in {None, "", "None", "none", " "} and hasattr(source, "get_markersize") and hasattr(source, "set_markersize"):
            source.set_markersize(float(source.get_markersize()) / safe_scale)
    except Exception:
        pass
    try:
        if hasattr(source, "get_sizes") and hasattr(source, "set_sizes"):
            sizes = source.get_sizes()
            if sizes is not None and len(sizes) > 0:
                source.set_sizes([float(size) / (safe_scale * safe_scale) for size in sizes])
    except Exception:
        pass
    return source


def _legend_marker_diameter_points(handles: list, marker_scale: float) -> float:
    diameter = 0.0
    for handle in handles:
        try:
            marker = handle.get_marker() if hasattr(handle, "get_marker") else None
            if marker not in {None, "", "None", "none", " "} and hasattr(handle, "get_markersize"):
                diameter = max(diameter, float(handle.get_markersize()) * marker_scale)
        except Exception:
            pass
        try:
            if hasattr(handle, "get_sizes"):
                sizes = handle.get_sizes()
                if sizes is not None and len(sizes) > 0:
                    diameter = max(diameter, max(float(size) for size in sizes) ** 0.5 * marker_scale)
        except Exception:
            pass
    return diameter


def _apply_legend_marker_yoffset_absolute(legend) -> None:
    offset = float(getattr(legend, "_scifigure_marker_yoffset", 0.0) or 0.0)
    if offset == 0:
        return
    for handle in _get_legend_handles(legend):
        try:
            if hasattr(handle, "get_ydata") and hasattr(handle, "set_ydata"):
                handle.set_ydata([float(y) + offset for y in handle.get_ydata()])
            if hasattr(handle, "get_offsets") and hasattr(handle, "set_offsets"):
                offsets = handle.get_offsets()
                if offsets is not None and len(offsets) > 0:
                    next_offsets = offsets.copy()
                    next_offsets[:, 1] = next_offsets[:, 1] + offset
                    handle.set_offsets(next_offsets)
            if hasattr(handle, "get_y") and hasattr(handle, "set_y"):
                handle.set_y(float(handle.get_y()) + offset)
        except Exception:
            continue


def _rebuild_legend_layout(legend, layout_source: dict) -> Optional[str]:
    try:
        old_texts = list(legend.get_texts())
        labels = [text.get_text() for text in old_texts]
        text_styles = [_snapshot_text_style(text) for text in old_texts]
        title = legend.get_title()
        title_text = title.get_text() if title is not None else ""
        title_style = _snapshot_text_style(title) if title is not None else None
        original_scale = float(layout_source.get("original_markerscale", 1.0) or 1.0)
        source_handles = [
            _normalized_legend_source_handle(handle, original_scale)
            for handle in layout_source.get("handles", [])
        ]
        if len(source_handles) != len(labels):
            return "legend_layout_source_mismatch"
        entry_font_sizes = [float(text.get_fontsize()) for text in old_texts if text.get_visible()]
        layout_font_size = max(entry_font_sizes or [float(getattr(legend, "_fontsize", 10.0) or 10.0)])
        legend._fontsize = layout_font_size
        marker_scale = max(0.1, float(getattr(legend, "markerscale", 1.0) or 1.0))
        marker_diameter = _legend_marker_diameter_points(source_handles, marker_scale)
        requested_height = float(getattr(legend, "_scifigure_requested_handleheight", layout_source.get("requested_handleheight", getattr(legend, "handleheight", 0.7))))
        requested_length = float(getattr(legend, "_scifigure_requested_handlelength", layout_source.get("requested_handlelength", getattr(legend, "handlelength", 2.0))))
        requested_borderpad = float(getattr(legend, "_scifigure_requested_borderpad", layout_source.get("requested_borderpad", getattr(legend, "borderpad", 0.4))))
        marker_ratio = marker_diameter / max(layout_font_size, 1.0)
        legend.handleheight = max(requested_height, marker_ratio + 0.15)
        legend.handlelength = max(requested_length, marker_ratio + 0.25)
        legend.borderpad = max(requested_borderpad, marker_ratio / 2.0 + 0.15)
        legend._init_legend_box(source_handles, labels, markerfirst=bool(layout_source.get("markerfirst", True)))
        legend._set_artist_props(legend._legend_box)
        legend._set_loc(getattr(legend, "_loc_real", getattr(legend, "_loc", 0)))
        legend.set_title(title_text)
        for next_text, style in zip(legend.get_texts(), text_styles):
            _restore_text_style(next_text, style)
        if title_style is not None:
            _restore_text_style(legend.get_title(), title_style)
        _apply_legend_marker_yoffset_absolute(legend)
        legend.stale = True
        return None
    except Exception as exc:
        return f"legend_layout_rebuild_error:{exc}"


def _apply_legend_marker_scale(legend, value: Any) -> None:
    legend.markerscale = max(0.1, float(value))


def _apply_legend_marker_yoffset(legend, value: Any) -> None:
    setattr(legend, "_scifigure_marker_yoffset", float(value))

# Map manifest prop names → matplotlib setter method names
_PROP_TO_SETTER = {
    "text": "set_text",
    "fontsize": "set_fontsize",
    "fontfamily": "set_fontname",
    "fontweight": "set_fontweight",
    "fontstyle": "set_fontstyle",
    "color": "set_color",
    "visible": "set_visible",
    "linewidth": "set_linewidth",
    "linestyle": "set_linestyle",
    "alpha": "set_alpha",
    "facecolor": "set_facecolor",
    "edgecolor": "set_edgecolor",
    "marker": "set_marker",
    "markersize": "set_markersize",
    "zorder": "set_zorder",
    "ha": "set_horizontalalignment",
    "va": "set_verticalalignment",
    "rotation": "set_rotation",
}


def _apply_color_patch(artist, value):
    """Apply a color change to an artist, dispatching based on artist type."""
    from matplotlib.lines import Line2D
    from matplotlib.text import Text
    from matplotlib.patches import Patch, Rectangle
    from matplotlib.collections import Collection
    from matplotlib.spines import Spine

    if isinstance(artist, (Line2D, Text, Spine)):
        artist.set_color(value)
        return None

    if isinstance(artist, (Patch, Rectangle)):
        artist.set_facecolor(value)
        return None

    if isinstance(artist, Collection):
        try:
            artist.set_color(value)
        except Exception:
            artist.set_facecolors([value])
        return None

    if hasattr(artist, "set_color"):
        artist.set_color(value)
        return None

    if hasattr(artist, "set_facecolor"):
        artist.set_facecolor(value)
        return None

    return "unsupported_color_patch"


def _color_hex(value: Any) -> Optional[str]:
    try:
        return mcolors.to_hex(value, keep_alpha=False).lower()
    except Exception:
        return None


def _replace_matching_color_rows(colors: Any, match_color: Any, value: Any):
    if colors is None:
        return None
    rows = colors.tolist() if hasattr(colors, "tolist") else colors
    if not isinstance(rows, (list, tuple)) or len(rows) == 0:
        return None
    match_hex = _color_hex(match_color)
    if not match_hex:
        return None
    try:
        new_rgba_base = list(mcolors.to_rgba(value))
    except Exception:
        return None
    changed = False
    next_rows = []
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            next_rows.append(row)
            continue
        if _color_hex(row) == match_hex:
            next_rgba = list(new_rgba_base)
            if len(row) >= 4:
                next_rgba[3] = float(row[3])
            next_rows.append(next_rgba)
            changed = True
        else:
            next_rows.append(row)
    return next_rows if changed else None


def _apply_color_subset_patch(artist, prop: str, value: Any, match_color: Any):
    from matplotlib.collections import Collection
    if not isinstance(artist, Collection):
        return "unsupported_color_subset_artist"
    if prop in {"facecolor", "color"} and hasattr(artist, "get_facecolors"):
        next_colors = _replace_matching_color_rows(artist.get_facecolors(), match_color, value)
        if next_colors is not None:
            artist.set_facecolors(next_colors)
            return None
    if prop in {"edgecolor", "color"} and hasattr(artist, "get_edgecolors"):
        next_colors = _replace_matching_color_rows(artist.get_edgecolors(), match_color, value)
        if next_colors is not None:
            artist.set_edgecolors(next_colors)
            return None
    if prop == "color" and hasattr(artist, "get_colors"):
        next_colors = _replace_matching_color_rows(artist.get_colors(), match_color, value)
        if next_colors is not None:
            artist.set_color(next_colors)
            return None
    return "no_matching_color_subset"


def _apply_single(artist, prop: str, value: Any, gid: str = ""):
    if gid.startswith(("xtick.", "ytick.")) and prop == "text":
        _set_tick_label_text_override(artist, gid, value)
        return

    if gid.startswith("heatmap."):
        if prop == "cmap":
            artist.set_cmap(value)
            cbar = getattr(artist, "colorbar", None)
            if cbar is not None:
                try:
                    cbar.update_normal(artist)
                except Exception:
                    pass
        elif prop == "vmin":
            current_clim = artist.get_clim()
            artist.set_clim(vmin=float(value), vmax=current_clim[1])
            cbar = getattr(artist, "colorbar", None)
            if cbar is not None:
                try:
                    cbar.update_normal(artist)
                except Exception:
                    pass
        elif prop == "vmax":
            current_clim = artist.get_clim()
            artist.set_clim(vmin=current_clim[0], vmax=float(value))
            cbar = getattr(artist, "colorbar", None)
            if cbar is not None:
                try:
                    cbar.update_normal(artist)
                except Exception:
                    pass
        elif prop == "alpha":
            artist.set_alpha(float(value))
        return

    if gid.startswith("colorbar."):
        # artist is the Colorbar wrapper object
        if prop == "label":
            artist.set_label(str(value))
        elif prop == "tick_fontsize":
            artist.ax.tick_params(labelsize=float(value))
        elif prop == "visible":
            artist.ax.set_visible(bool(value))
        elif prop in ("left", "bottom", "width", "height"):
            try:
                if hasattr(artist.ax, "set_axes_locator"):
                    artist.ax.set_axes_locator(None)
                if hasattr(artist.ax, "set_box_aspect"):
                    artist.ax.set_box_aspect(None)
                if hasattr(artist.ax, "set_aspect"):
                    artist.ax.set_aspect("auto")

                bounds = list(artist.ax.get_position().bounds)
                if prop == "left":
                    bounds[0] = float(value)
                elif prop == "bottom":
                    bounds[1] = float(value)
                elif prop == "width":
                    bounds[2] = float(value)
                elif prop == "height":
                    bounds[3] = float(value)
                artist.ax.set_position(bounds)
            except Exception:
                pass
        return

    if gid.startswith("container.bar."):
        for child in artist:
            if prop == "color" or prop == "facecolor":
                child.set_facecolor(value)
            elif prop == "edgecolor":
                child.set_edgecolor(value)
            elif prop == "linewidth":
                child.set_linewidth(float(value))
            elif prop == "alpha":
                child.set_alpha(float(value))
        return

    if gid.startswith("container.errorbar."):
        data_line = artist.lines[0]
        cap_lines = artist.lines[1]
        bar_cols = artist.lines[2]
        
        if prop == "color":
            if data_line is not None:
                data_line.set_color(value)
            for cap in cap_lines:
                cap.set_color(value)
            for col in bar_cols:
                col.set_color(value)
        elif prop == "linewidth":
            if data_line is not None:
                data_line.set_linewidth(float(value))
        elif prop == "elinewidth":
            for col in bar_cols:
                col.set_linewidth(float(value))
        elif prop == "capthick":
            for cap in cap_lines:
                cap.set_linewidth(float(value))
        elif prop == "capsize":
            for cap in cap_lines:
                cap.set_markersize(float(value) * 2.0)
        elif prop == "alpha":
            if data_line is not None:
                data_line.set_alpha(float(value))
            for cap in cap_lines:
                cap.set_alpha(float(value))
            for col in bar_cols:
                col.set_alpha(float(value))
        elif prop == "marker":
            if data_line is not None:
                data_line.set_marker(value)
        elif prop == "markersize":
            if data_line is not None:
                data_line.set_markersize(float(value))
        return

    if gid.startswith("container.stem."):
        markerline = getattr(artist, "markerline", None)
        stemlines = getattr(artist, "stemlines", None)
        baseline = getattr(artist, "baseline", None)

        if prop == "color":
            if markerline is not None:
                markerline.set_color(value)
            if stemlines is not None:
                stemlines.set_color(value)
        elif prop == "stem_color" and stemlines is not None:
            stemlines.set_color(value)
        elif prop == "stem_linewidth" and stemlines is not None:
            stemlines.set_linewidth(float(value))
        elif prop == "marker" and markerline is not None:
            markerline.set_marker(value)
        elif prop == "marker_color" and markerline is not None:
            markerline.set_color(value)
        elif prop == "markersize" and markerline is not None:
            markerline.set_markersize(float(value))
        elif prop == "baseline_color" and baseline is not None:
            baseline.set_color(value)
        elif prop == "baseline_linewidth" and baseline is not None:
            baseline.set_linewidth(float(value))
        elif prop == "baseline_visible" and baseline is not None:
            baseline.set_visible(bool(value))
        elif prop == "alpha":
            if markerline is not None:
                markerline.set_alpha(float(value))
            if stemlines is not None:
                stemlines.set_alpha(float(value))
            if baseline is not None:
                baseline.set_alpha(float(value))
        return

    if gid.startswith("container.boxplot."):
        bp = artist.bp_dict
        if prop == "color":
            for part in ("boxes", "whiskers", "caps", "medians", "fliers"):
                for line in bp.get(part, []):
                    line.set_color(value)
        elif prop == "linewidth":
            for part in ("boxes", "whiskers", "caps", "medians"):
                for line in bp.get(part, []):
                    line.set_linewidth(float(value))
        elif prop == "alpha":
            for part in ("boxes", "whiskers", "caps", "medians", "fliers"):
                for line in bp.get(part, []):
                    line.set_alpha(float(value))
        elif prop == "box_color":
            for line in bp.get("boxes", []):
                line.set_color(value)
        elif prop == "median_color":
            for line in bp.get("medians", []):
                line.set_color(value)
        return

    if gid.startswith("container.violinplot."):
        vp = artist.vp_dict
        bodies = vp.get("bodies", [])
        c_lines = [vp.get("cbars"), vp.get("cmins"), vp.get("cmaxes"), vp.get("cmeans"), vp.get("cmedians")]
        
        if prop == "color" or prop == "facecolor":
            for body in bodies:
                body.set_facecolor(value)
            if prop == "color":
                for item in c_lines:
                    if item is not None:
                        item.set_color(value)
        elif prop == "edgecolor":
            for body in bodies:
                body.set_edgecolor(value)
        elif prop == "linewidth":
            for body in bodies:
                body.set_linewidth(float(value))
            for item in c_lines:
                if item is not None:
                    item.set_linewidth(float(value))
        elif prop == "alpha":
            for body in bodies:
                body.set_alpha(float(value))
            for item in c_lines:
                if item is not None:
                    item.set_alpha(float(value))
        return

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

    if gid.startswith("subplot."):
        if prop in {"left", "bottom", "width", "height"}:
            bounds = list(artist.get_position().bounds)
            idx = {"left": 0, "bottom": 1, "width": 2, "height": 3}[prop]
            bounds[idx] = float(value)
            bounds[0] = max(0.0, min(1.0, bounds[0]))
            bounds[1] = max(0.0, min(1.0, bounds[1]))
            bounds[2] = max(0.005, min(1.0, bounds[2]))
            bounds[3] = max(0.005, min(1.0, bounds[3]))
            artist.set_position(bounds)
            return
        if prop == "aspect":
            if str(value) == "auto":
                artist.set_aspect("auto")
            elif str(value) == "equal":
                artist.set_aspect("equal", adjustable="box")
            else:
                artist.set_aspect(float(value), adjustable="box")
            return
        if prop == "zorder":
            artist.set_zorder(float(value))
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
            for label in artist.get_ticklabels():
                label.set_fontsize(float(value))
            return
        if prop == "tick_labelcolor":
            parent_ax.tick_params(axis=axis_name, which="major", labelcolor=value)
            for label in artist.get_ticklabels():
                label.set_color(value)
            return
        if prop == "tick_labelfamily":
            for label in artist.get_ticklabels():
                _set_text_fontfamily(label, value)
            return
        if prop == "tick_fontweight":
            for label in artist.get_ticklabels():
                label.set_fontweight(str(value))
            return
        if prop == "tick_fontstyle":
            for label in artist.get_ticklabels():
                label.set_fontstyle(str(value))
            return
        if prop == "tick_label_dx":
            setattr(artist, "_scifigure_tick_label_dx", float(value))
            _apply_tick_label_offset(artist, axis_name)
            return
        if prop == "tick_label_dy":
            setattr(artist, "_scifigure_tick_label_dy", float(value))
            _apply_tick_label_offset(artist, axis_name)
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
            parent_ax.tick_params(axis=axis_name, which="major", color=value)
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
            parent_ax.tick_params(axis=axis_name, which="minor", color=value)
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
            _set_legend_loc(artist, str(value))
        elif prop == "ncol":
            artist.set_ncols(int(value))
        elif prop == "markerscale":
            _apply_legend_marker_scale(artist, value)
        elif prop == "marker_yoffset":
            _apply_legend_marker_yoffset(artist, value)
        elif prop == "handletextpad":
            artist.handletextpad = float(value)
        elif prop == "labelspacing":
            artist.labelspacing = float(value)
        elif prop == "handlelength":
            artist.handlelength = max(0.1, float(value))
            setattr(artist, "_scifigure_requested_handlelength", artist.handlelength)
        elif prop == "handleheight":
            artist.handleheight = max(0.1, float(value))
            setattr(artist, "_scifigure_requested_handleheight", artist.handleheight)
        elif prop == "columnspacing":
            artist.columnspacing = max(0.0, float(value))
        elif prop == "borderpad":
            artist.borderpad = max(0.0, float(value))
            setattr(artist, "_scifigure_requested_borderpad", artist.borderpad)
        elif prop == "borderaxespad":
            artist.borderaxespad = max(0.0, float(value))
        elif prop == "title":
            artist.set_title(str(value))
        elif prop == "fontfamily":
            for text in artist.get_texts():
                _set_text_fontfamily(text, value)
            title = artist.get_title()
            if title is not None:
                _set_text_fontfamily(title, value)
        elif prop == "position":
            x = float(value["x"])
            y = float(value["y"])
            coord_system = value.get("coord_system", "figure")
            if coord_system != "figure":
                return "unsupported_legend_position_coord"
            _set_legend_loc(artist, "center")
            artist.set_bbox_to_anchor((x, y), transform=artist.figure.transFigure)
        elif prop == "fontweight":
            for text in artist.get_texts():
                text.set_fontweight(str(value))
            title = artist.get_title()
            if title is not None:
                title.set_fontweight(str(value))
        elif prop == "fontstyle":
            for text in artist.get_texts():
                text.set_fontstyle(str(value))
            title = artist.get_title()
            if title is not None:
                title.set_fontstyle(str(value))
        return

    if gid.startswith(("legend_text.", "legend_title.")) and prop == "position":
        return "unsupported_legend_child_position"

    if prop == "anchor_position":
        try:
            from matplotlib.text import Annotation
            if not isinstance(artist, Annotation):
                return "unsupported_annotation_anchor"
            x = float(value["x"])
            y = float(value["y"])
            coord_system = value.get("coord_system", "data")
            mpl_coord = _matplotlib_annotation_coord(coord_system)
            if mpl_coord is None:
                return "unsupported_annotation_anchor_coord"
            artist.xycoords = mpl_coord
            artist.xy = (x, y)
            return
        except Exception:
            return "unsupported_annotation_anchor"

    if prop == "position":
        x = float(value["x"])
        y = float(value["y"])
        coord_system = value.get("coord_system", "axes")
        ax = artist.axes
        fig = artist.figure
        axis_label = _axis_label_context(artist)
        if axis_label is not None:
            label_ax, axis = axis_label
            if coord_system != "axes":
                return "unsupported_axis_label_position_coord"
            if max(abs(x), abs(y)) > 10:
                return "unsupported_legacy_axis_label_position"
            axis.set_label_coords(x, y, transform=label_ax.transAxes)
            return
        axes_title = _axes_title_context(artist)
        if axes_title is not None:
            title_ax, _ = axes_title
            if coord_system != "axes":
                return "unsupported_axes_title_position_coord"
            if max(abs(x), abs(y)) > 10:
                return "unsupported_legacy_axes_title_position"
            title_ax._autotitlepos = False
            artist.set_transform(title_ax.transAxes)
            artist.set_position((x, y))
            return
        try:
            from matplotlib.text import Annotation
            if isinstance(artist, Annotation):
                mpl_coord = _matplotlib_annotation_coord(coord_system)
                if mpl_coord is None:
                    return "unsupported_text_position_coord"
                artist.anncoords = mpl_coord
                artist.set_position((x, y))
                return
        except Exception:
            pass
        if coord_system == "axes" and ax is not None:
            artist.set_transform(ax.transAxes)
        elif coord_system == "data" and ax is not None:
            artist.set_transform(ax.transData)
        elif coord_system == "figure" and fig is not None:
            artist.set_transform(fig.transFigure)
        else:
            return "unsupported_text_position_coord"
        artist.set_position((x, y))
        return

    if prop == "size" and hasattr(artist, "set_sizes"):
        artist.set_sizes([float(value)])
        return

    if prop == "size_scale" and hasattr(artist, "get_sizes") and hasattr(artist, "set_sizes"):
        scale = float(value)
        if scale <= 0:
            return "invalid_size_scale"
        sizes = artist.get_sizes()
        if sizes is None or len(sizes) == 0:
            return "no_sizes_to_scale"
        artist.set_sizes([float(size) * scale for size in sizes])
        return

    # Fallback to _PROP_TO_SETTER for common props
    setter_name = _PROP_TO_SETTER.get(prop)
    if setter_name is None:
        return "unsupported_prop"
    setter = getattr(artist, setter_name, None)
    if setter is None:
        return "no_setter"
    try:
        if prop == "color":
            return _apply_color_patch(artist, value)
        if prop == "fontfamily":
            _set_text_fontfamily(artist, value)
            return None
        if prop == "zorder":
            setter(float(value))
        else:
            setter(value)
    except Exception as e:
        return f"apply_error:{e}"
    return None


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


def _apply_virtual_font_center_patch(fig, gid: str, prop: str, value: Any) -> bool:
    """Backward compatibility for edit logs written with UI control ids.

    Older RightSidebar builds accidentally persisted ids like
    ``font-center-yticks`` instead of real matplotlib gids.  Expand them here so
    existing projects remain replayable after refresh/reopen.
    """
    if gid not in {"font-center-xticks", "font-center-yticks"}:
        return False

    axis_prefix = "axis.x." if gid == "font-center-xticks" else "axis.y."
    if prop == "fontsize":
        axis_prop = "tick_labelsize"
    elif prop == "fontfamily":
        axis_prop = "tick_labelfamily"
    elif prop == "color":
        axis_prop = "tick_labelcolor"
    elif prop == "fontweight":
        axis_prop = "tick_fontweight"
    elif prop == "fontstyle":
        axis_prop = "tick_fontstyle"
    else:
        return True

    for ax_idx, ax in enumerate(fig.axes):
        axis_artist = ax.xaxis if axis_prefix == "axis.x." else ax.yaxis
        _apply_single(axis_artist, axis_prop, value, f"{axis_prefix}{ax_idx}")
    return True


def apply_edit_log(fig, edit_log: list[dict]) -> list[dict]:
    """Apply an edit_log to a Figure in-place.

    Called AFTER the script has been executed but BEFORE introspection.

    Returns a list of warnings for unsupported or failed patch entries.
    """
    gid_map = _build_gid_map(fig)
    legend_layout_sources = {
        gid: _capture_legend_layout(artist)
        for gid, artist in gid_map.items()
        if gid.startswith("legend.")
    }
    dirty_legend_ids: set[str] = set()
    needs_layout_refresh = False
    has_manual_positioning = False
    warnings: list[dict] = []

    for entry in edit_log:
        gid = entry.get("gid")
        prop = entry.get("prop")
        value = entry.get("value")
        mode = entry.get("mode", "unknown")

        if gid == "global":
            _apply_global(fig, prop, value)
            continue

        if _apply_virtual_font_center_patch(fig, gid, prop, value):
            continue

        artist = gid_map.get(gid)
        if artist is None:
            continue

        legend_id = gid if gid in legend_layout_sources else _legend_container_gid(gid)
        if legend_id and prop in {
            "text",
            "fontsize",
            "fontfamily",
            "fontweight",
            "fontstyle",
            "rotation",
            "title",
            "ncol",
            "markerscale",
            "marker_yoffset",
            "handletextpad",
            "labelspacing",
            "handlelength",
            "handleheight",
            "columnspacing",
            "borderpad",
            "borderaxespad",
            "markersize",
            "size",
        }:
            dirty_legend_ids.add(legend_id)

        if (
            gid.startswith("colorbar.") and prop in {"left", "bottom", "width", "height"}
        ) or (
            gid.startswith("subplot.") and prop in {"left", "bottom", "width", "height", "aspect"}
        ) or (
            gid.startswith("legend.") and prop == "position"
        ):
            has_manual_positioning = True

        match_color = entry.get("matchColor")
        if match_color and prop in {"color", "facecolor", "edgecolor"}:
            result = _apply_color_subset_patch(artist, prop, value, match_color)
        else:
            result = _apply_single(artist, prop, value, gid)
        if result is not None:
            warnings.append({
                "type": result,
                "mode": mode,
                "gid": gid,
                "prop": prop,
                "value": value,
                "artist": type(artist).__name__,
            })

        if prop in {
            "fontsize",
            "fontfamily",
            "text",
            "label",
            "label_fontsize",
            "tick_labelsize",
            "tick_labelfamily",
            "title",
            "ncol",
            "markerscale",
            "handletextpad",
            "labelspacing",
            "handlelength",
            "handleheight",
            "columnspacing",
            "borderpad",
            "borderaxespad",
        }:
            needs_layout_refresh = True

    for legend_id in sorted(dirty_legend_ids):
        legend = gid_map.get(legend_id)
        layout_source = legend_layout_sources.get(legend_id)
        if legend is None or layout_source is None:
            continue
        result = _rebuild_legend_layout(legend, layout_source)
        if result is not None:
            warnings.append({
                "type": result,
                "mode": "backend_patch",
                "gid": legend_id,
                "prop": "layout",
                "artist": type(legend).__name__,
            })

    if needs_layout_refresh and not has_manual_positioning:
        try:
            fig.tight_layout()
        except Exception:
            pass

    return warnings


# ---------------------------------------------------------------------------
# Full replay pipeline
# ---------------------------------------------------------------------------

_FIGURE_CREATION_CALLS = {
    "plt.figure",
    "plt.subplots",
    "plt.subplot",
    "matplotlib.pyplot.figure",
    "matplotlib.pyplot.subplots",
    "matplotlib.pyplot.subplot",
}

_PLOTTING_CALL_NAMES = {
    "plot",
    "scatter",
    "bar",
    "barh",
    "boxplot",
    "violinplot",
    "hist",
    "imshow",
    "pcolormesh",
    "contour",
    "contourf",
    "errorbar",
    "fill_between",
    "text",
    "annotate",
    "legend",
    "set_title",
    "set_xlabel",
    "set_ylabel",
    "suptitle",
    "supxlabel",
    "supylabel",
}


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _call_name(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return ""


def _node_line_range(node: ast.AST) -> tuple[int, int]:
    start = int(getattr(node, "lineno", 1) or 1)
    end = int(getattr(node, "end_lineno", start) or start)
    return start, end


def _slice_lines(lines: list[str], start_line: int, end_line: int) -> str:
    start = max(start_line, 1)
    end = min(end_line, len(lines))
    if end < start:
        return ""
    return "\n".join(lines[start - 1:end])


def _contains_figure_creation(node: ast.AST) -> bool:
    for child in ast.walk(node):
        if isinstance(child, ast.Call) and _call_name(child.func) in _FIGURE_CREATION_CALLS:
            return True
    return False


def _plotting_score(node: ast.AST) -> int:
    score = 0
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            name = _call_name(child.func)
            tail = name.split(".")[-1]
            if name in _FIGURE_CREATION_CALLS:
                score += 4
            elif tail in _PLOTTING_CALL_NAMES:
                score += 1
    return score


def extract_figure_code_slices(script: str, figure_count: int) -> list[dict]:
    """Best-effort static mapping from rendered Figure order to source code ranges."""
    lines = script.splitlines()
    fallback_end = max(len(lines), 1)

    def fallback(reason: str, idx: int) -> dict:
        return {
            "figureId": f"fig_{idx + 1}",
            "title": f"Figure {idx + 1} 关联代码",
            "startLine": 1,
            "endLine": fallback_end,
            "code": script,
            "confidence": "low",
            "mode": "whole_script",
            "reason": reason,
            "relatedFunctions": [],
        }

    if figure_count <= 0:
        return []

    try:
        tree = ast.parse(script)
    except SyntaxError as exc:
        return [fallback(f"脚本语法暂不可静态切块：{exc}", i) for i in range(figure_count)]

    function_defs: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    top_level_statements = [
        node for node in tree.body
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom))
    ]
    figure_creation_statements = [node for node in top_level_statements if _contains_figure_creation(node)]

    if len(figure_creation_statements) >= figure_count:
        slices = []
        for idx in range(figure_count):
            start, _ = _node_line_range(figure_creation_statements[idx])
            if idx + 1 < len(figure_creation_statements):
                next_start, _ = _node_line_range(figure_creation_statements[idx + 1])
                end = max(next_start - 1, start)
            else:
                end = fallback_end
            slices.append({
                "figureId": f"fig_{idx + 1}",
                "title": f"Figure {idx + 1} 顶层代码块",
                "startLine": start,
                "endLine": end,
                "code": _slice_lines(lines, start, end),
                "confidence": "high",
                "mode": "exact_range",
                "reason": "检测到顶层 Figure 创建语句，按相邻 Figure 创建点切分。",
                "relatedFunctions": [],
            })
        return slices

    called_function_names: list[str] = []
    for stmt in top_level_statements:
        for child in ast.walk(stmt):
            if isinstance(child, ast.Call):
                name = _call_name(child.func)
                if name in function_defs and name not in called_function_names:
                    called_function_names.append(name)

    candidate_names = called_function_names or list(function_defs.keys())
    scored_candidates = [
        (name, _plotting_score(function_defs[name]), function_defs[name])
        for name in candidate_names
        if name in function_defs
    ]
    scored_candidates = [item for item in scored_candidates if item[1] > 0]
    if scored_candidates:
        name, _, func_node = sorted(scored_candidates, key=lambda item: item[1], reverse=True)[0]
        start, end = _node_line_range(func_node)
        code = _slice_lines(lines, start, end)
        return [
            {
                "figureId": f"fig_{idx + 1}",
                "title": f"Figure {idx + 1} 共享函数：{name}()",
                "startLine": start,
                "endLine": end,
                "code": code,
                "confidence": "medium",
                "mode": "shared_function",
                "reason": "多张 Figure 由同一个绘图函数生成，当前显示共享函数上下文。",
                "relatedFunctions": [name],
            }
            for idx in range(figure_count)
        ]

    return [fallback("未检测到明确的 Figure 创建语句或绘图函数，显示完整脚本。", i) for i in range(figure_count)]


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
    import io
    import os
    import base64
    import matplotlib.pyplot as plt

    start = time.perf_counter()
    timing_breakdown = {
        "staticScanMs": 0,
        "scriptExecutionMs": 0,
        "dynamicScanMs": 0,
        "figureDiscoveryMs": 0,
        "editApplyMs": 0,
        "introspectionMs": 0,
        "svgSerializeMs": 0,
        "binaryExportMs": 0,
    }

    def elapsed_ms(since: float) -> int:
        return max(0, round((time.perf_counter() - since) * 1000))
    
    # Clear the figure registry for this run
    _figure_registry.clear()
    _intercepted_containers.clear()

    # Parse AST / regex static scan
    semantic_manifest = None
    static_scan_started = time.perf_counter()
    try:
        from semantic_scanner import scan_source
        semantic_manifest = scan_source(script)
    except Exception as e:
        import sys
        print(f"Error scanning source statically: {e}", file=sys.stderr)
    timing_breakdown["staticScanMs"] = elapsed_ms(static_scan_started)

    # --- 1. Switch working directory if provided ---
    original_cwd = os.getcwd()
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)

    # --- 2. Execute script ---
    ns: dict = {
        "__name__": "__main__",
        "_uploaded_data": data.get("custom_data", []) if data else [],
        "_uploaded_file_paths": uploaded_file_paths or {},
    }

    script_execution_started = time.perf_counter()
    try:
        with _guard_user_script_io(cwd, uploaded_file_paths=uploaded_file_paths, original_cwd=original_cwd):
            exec(script, ns, ns)
    except Exception as exc:
        os.chdir(original_cwd)
        timing_breakdown["scriptExecutionMs"] = elapsed_ms(script_execution_started)
        total_ms = elapsed_ms(start)
        return {
            "status": "error",
            "message": _build_script_error_message(exc, data),
            "traceback": traceback.format_exc(),
            "timingMs": total_ms,
            "timingBreakdown": {**timing_breakdown, "totalMs": total_ms},
        }
    timing_breakdown["scriptExecutionMs"] = elapsed_ms(script_execution_started)

    # Fallback/dynamic updates from namespace
    dynamic_scan_started = time.perf_counter()
    if semantic_manifest:
        try:
            from semantic_scanner import scan_source
            semantic_manifest = scan_source(script, namespace=ns)
        except Exception as e:
            import sys
            print(f"Error scanning source dynamically: {e}", file=sys.stderr)
    timing_breakdown["dynamicScanMs"] = elapsed_ms(dynamic_scan_started)

    # --- 3. Fallback scan for active figures ---
    figure_discovery_started = time.perf_counter()
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
        timing_breakdown["figureDiscoveryMs"] = elapsed_ms(figure_discovery_started)
        total_ms = elapsed_ms(start)
        return {
            "status": "error",
            "message": "脚本未创建任何 matplotlib Figure",
            "timingMs": total_ms,
            "timingBreakdown": {**timing_breakdown, "totalMs": total_ms},
        }

    # --- 4. Process each Figure ---
    figures_data = []
    all_warnings: list[dict] = []
    code_slices = extract_figure_code_slices(script, len(unique_figures))
    timing_breakdown["figureDiscoveryMs"] = elapsed_ms(figure_discovery_started)
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
            edit_apply_started = time.perf_counter()
            fig_warnings = apply_edit_log(fig, fig_edit_log)
            timing_breakdown["editApplyMs"] += elapsed_ms(edit_apply_started)
            for w in fig_warnings:
                w["figureId"] = fig_id
            all_warnings.extend(fig_warnings)

        # Introspect
        result = introspect_figure(fig, semantic_manifest=semantic_manifest)
        figure_timing = result.get("timingBreakdown", {})
        timing_breakdown["introspectionMs"] += int(figure_timing.get("introspectionMs", 0) or 0)
        timing_breakdown["svgSerializeMs"] += int(figure_timing.get("svgSerializeMs", 0) or 0)

        # Compute figure fingerprint for identity tracking
        manifest = result.get("manifest", {})
        objects = manifest.get("objects", [])
        axes_count = len(getattr(fig, "axes", []) or [])
        kind_counts = {}
        for obj in objects:
            k = obj.get("kind", "unknown")
            kind_counts[k] = kind_counts.get(k, 0) + 1
        suptitle_text = ""
        if hasattr(fig, "_suptitle") and fig._suptitle:
            suptitle_text = fig._suptitle.get_text() if hasattr(fig._suptitle, "get_text") else str(fig._suptitle)
        axes_titles = []
        for ax in (getattr(fig, "axes", []) or []):
            try:
                axes_titles.append(ax.get_title() or "")
            except Exception:
                pass
        fingerprint_parts = [
            f"axes:{axes_count}",
            f"suptitle:{suptitle_text}",
            "axes_titles:" + "||".join(axes_titles),
            f"objects:{len(objects)}",
        ]
        for kind in sorted(kind_counts.keys()):
            fingerprint_parts.append(f"{kind}:{kind_counts[kind]}")
        fingerprint_src = "|".join(fingerprint_parts)
        fingerprint = hashlib.sha256(fingerprint_src.encode("utf-8")).hexdigest()[:16]
        
        # Render and export to binary format if requested
        binary_b64 = None
        if export_format and export_format.lower() in ['png', 'pdf', 'tiff', 'eps']:
            binary_export_started = time.perf_counter()
            buf = io.BytesIO()
            fmt = export_format.lower()
            if fmt == 'tiff':
                from PIL import Image
                png_buf = io.BytesIO()
                fig.savefig(png_buf, format='png', dpi=dpi, bbox_inches='tight')
                png_buf.seek(0)
                img = Image.open(png_buf)
                img.save(buf, format='TIFF', compression='tiff_lzw', dpi=(dpi, dpi))
            else:
                fig.savefig(buf, format=fmt, dpi=dpi, bbox_inches='tight')
            binary_b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
            timing_breakdown["binaryExportMs"] += elapsed_ms(binary_export_started)

        fig_entry = {
            "figureId": fig_id,
            "svg": result["svg"],
            "manifest": result["manifest"],
            "fingerprint": fingerprint,
            "axesCount": axes_count,
            "objectCount": len(objects),
            "kindCounts": kind_counts,
            "codeSlice": code_slices[idx] if idx < len(code_slices) else None,
        }
        if binary_b64:
            fig_entry["binary_b64"] = binary_b64
            fig_entry["format"] = export_format.lower()

        figures_data.append(fig_entry)

    plt.close("all")
    os.chdir(original_cwd)
    
    elapsed = elapsed_ms(start)
    timing_breakdown["totalMs"] = elapsed

    # Return unified response ensuring backward compatibility
    ret = {
        "status": "success",
        "timingMs": elapsed,
        "timingBreakdown": timing_breakdown,
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
    ret["codeSlices"] = code_slices
    # Expose patch warnings
    if all_warnings:
        ret["warnings"] = all_warnings
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
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--payload-file", help="Path to JSON payload file")
    args = parser.parse_args()

    if args.payload_file:
        with open(args.payload_file, "r", encoding="utf-8") as f:
            payload = json.load(f)
    else:
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
