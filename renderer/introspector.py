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
from urllib.parse import parse_qs, urlencode

import matplotlib
import matplotlib.colors as mcolors
matplotlib.use("Agg")
import numpy as np
from matplotlib.transforms import Bbox


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
_intercepted_complex_artists = {}


def _ast_call_chain(node: Any) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _ast_call_chain(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def _scan_determinism_warnings(source: str) -> list[dict[str, Any]]:
    """Report non-replayable source hints without blocking execution."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return []

    seeded_numpy = False
    seeded_random = False
    warnings: list[dict[str, Any]] = []

    def add(symbol: str, node: ast.AST, message: str) -> None:
        warnings.append({
            "type": "non_deterministic_source",
            "symbol": symbol,
            "line": int(getattr(node, "lineno", 0) or 0),
            "message": message,
            "suggestion": "为随机数或时间来源提供固定输入，便于重复渲染和恢复历史状态。",
        })

    def is_fixed_seed_value(value: ast.AST) -> bool:
        if isinstance(value, ast.Constant):
            return value.value is not None
        if isinstance(value, (ast.List, ast.Tuple)):
            return bool(value.elts) and all(is_fixed_seed_value(item) for item in value.elts)
        if isinstance(value, ast.UnaryOp) and isinstance(value.op, (ast.UAdd, ast.USub)):
            return is_fixed_seed_value(value.operand)
        return False

    def has_fixed_seed(node: ast.Call) -> bool:
        values = list(node.args) + [keyword.value for keyword in node.keywords]
        return bool(values) and all(is_fixed_seed_value(value) for value in values)

    parents = {
        id(child): parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }

    def is_unconditionally_executed(node: ast.AST) -> bool:
        """Accept only module-level calls; branches and deferred scopes are uncertain."""
        current = node
        while (parent := parents.get(id(current))) is not None:
            if isinstance(parent, ast.Module):
                return True
            if isinstance(
                parent,
                (ast.AsyncFunctionDef, ast.ClassDef, ast.For, ast.FunctionDef, ast.If,
                 ast.Try, ast.While, ast.With, ast.AsyncFor, ast.AsyncWith),
            ):
                return False
            current = parent
        return False

    numpy_module_aliases = {"np", "numpy"}
    random_module_aliases = {"random"}
    random_seed_aliases: set[str] = set()
    random_api_aliases: set[str] = set()
    for import_node in ast.walk(tree):
        if isinstance(import_node, ast.Import):
            for imported in import_node.names:
                if imported.name == "numpy":
                    numpy_module_aliases.add(imported.asname or imported.name)
                elif imported.name == "random":
                    random_module_aliases.add(imported.asname or imported.name)
        elif isinstance(import_node, ast.ImportFrom) and import_node.module == "random":
            for imported in import_node.names:
                alias = imported.asname or imported.name
                if imported.name == "seed":
                    random_seed_aliases.add(alias)
                elif imported.name != "*":
                    random_api_aliases.add(alias)

    calls = sorted(
        (node for node in ast.walk(tree) if isinstance(node, ast.Call)),
        key=lambda node: (int(getattr(node, "lineno", 0) or 0), int(getattr(node, "col_offset", 0) or 0)),
    )
    for node in calls:
        chain = _ast_call_chain(node.func)
        if chain in {f"{alias}.random.seed" for alias in numpy_module_aliases}:
            if is_unconditionally_executed(node):
                seeded_numpy = has_fixed_seed(node)
            continue
        if chain in random_seed_aliases or chain in {f"{alias}.seed" for alias in random_module_aliases}:
            if is_unconditionally_executed(node):
                seeded_random = has_fixed_seed(node)
            continue
        if chain in {f"{alias}.random.default_rng" for alias in numpy_module_aliases}:
            if not has_fixed_seed(node):
                add("numpy.random", node, "default_rng 未提供固定 seed。")
            continue
        if any(chain.startswith(f"{alias}.random.") for alias in numpy_module_aliases) and not seeded_numpy:
            add("numpy.random", node, "numpy.random 调用未发现固定 seed。")
            continue
        if (
            (any(chain.startswith(f"{alias}.") for alias in random_module_aliases) or chain in random_api_aliases)
            and not seeded_random
        ):
            add("random", node, "random 调用未发现固定 seed。")
            continue
        if chain in {"time.time", "time.time_ns", "datetime.datetime.now", "datetime.now", "datetime.date.today", "date.today"}:
            add(chain, node, "当前时间会随渲染变化。")

    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for item in warnings:
        key = (str(item.get("symbol")), int(item.get("line") or 0))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _window_bbox(artist: Any, renderer: Any) -> Any:
    try:
        return artist.get_window_extent(renderer)
    except (AttributeError, RuntimeError, ValueError):
        return None


def _bbox_outside(inner: Any, outer: Any, tolerance: float = 1.0) -> bool:
    if inner is None or outer is None:
        return False
    return (
        inner.x0 < outer.x0 - tolerance
        or inner.y0 < outer.y0 - tolerance
        or inner.x1 > outer.x1 + tolerance
        or inner.y1 > outer.y1 + tolerance
    )


def _bbox_overlaps(first: Any, second: Any, tolerance: float = 0.5) -> bool:
    if first is None or second is None:
        return False
    return (
        min(first.x1, second.x1) - max(first.x0, second.x0) > tolerance
        and min(first.y1, second.y1) - max(first.y0, second.y0) > tolerance
    )


def _collect_layout_warnings(fig: Any) -> list[dict[str, Any]]:
    """Collect conservative clipping/overlap diagnostics for user-facing layout objects."""
    try:
        canvas = fig.canvas
        renderer = getattr(canvas, "renderer", None) or canvas.get_renderer()
        figure_bbox = fig.bbox
        candidates: list[tuple[str, Any]] = []
        for index, legend in enumerate(getattr(fig, "legends", []) or []):
            bbox = _window_bbox(legend, renderer)
            if bbox is not None:
                candidates.append((f"figure.legend.{index}", bbox))

        for axes_index, ax in enumerate(getattr(fig, "axes", []) or []):
            title = getattr(ax, "title", None)
            if title is not None and title.get_text():
                bbox = _window_bbox(title, renderer)
                if bbox is not None:
                    candidates.append((f"axes.{axes_index}.title", bbox))
            for label_name, label in (
                ("xlabel", getattr(ax, "xaxis", None).get_label() if getattr(ax, "xaxis", None) else None),
                ("ylabel", getattr(ax, "yaxis", None).get_label() if getattr(ax, "yaxis", None) else None),
            ):
                if label is not None and label.get_text():
                    bbox = _window_bbox(label, renderer)
                    if bbox is not None:
                        candidates.append((f"axes.{axes_index}.{label_name}", bbox))
            for axis_name, labels in (
                ("x_tick", ax.get_xticklabels()),
                ("y_tick", ax.get_yticklabels()),
            ):
                for label_index, label in enumerate(labels):
                    if not label.get_visible() or not label.get_text():
                        continue
                    bbox = _window_bbox(label, renderer)
                    if bbox is not None:
                        candidates.append((f"axes.{axes_index}.{axis_name}.{label_index}", bbox))

        warnings: list[dict[str, Any]] = []
        for name, bbox in candidates:
            if _bbox_outside(bbox, figure_bbox):
                warnings.append({
                    "type": "layout_clip",
                    "element": name,
                    "message": "文字或图例超出原始 Figure 边界，渲染器已自动扩展白底画布。",
                    "suggestion": "如需保持原始物理画布尺寸，请调整边距、字号、旋转角度或图例位置。",
                })

        major_candidates = [
            (name, bbox)
            for name, bbox in candidates
            if ".title" in name or name.startswith("figure.legend") or ".xlabel" in name or ".ylabel" in name
        ]
        for index, (first_name, first_bbox) in enumerate(major_candidates):
            for second_name, second_bbox in major_candidates[index + 1:]:
                if _bbox_overlaps(first_bbox, second_bbox):
                    warnings.append({
                        "type": "layout_overlap",
                        "elements": [first_name, second_name],
                        "message": "标题、图例或轴标签的显示区域发生重叠。",
                        "suggestion": "调整布局间距、位置或字号后重新渲染。",
                    })

        for axes_index, ax in enumerate(getattr(fig, "axes", []) or []):
            clipped_diagram_objects: list[str] = []
            for artist in ax.get_children():
                try:
                    if not artist.get_visible() or not artist.get_clip_on():
                        continue
                except (AttributeError, TypeError):
                    continue
                provenance = _register_explicit_diagram_artist(artist)
                if not provenance or provenance.get("family") != "diagram":
                    continue
                bbox = _window_bbox(artist, renderer)
                if not _bbox_outside(bbox, ax.bbox):
                    continue
                object_id = str(provenance.get("diagramObjectId") or "diagram_object")
                if object_id not in clipped_diagram_objects:
                    clipped_diagram_objects.append(object_id)
            if clipped_diagram_objects:
                warnings.append({
                    "type": "axes_content_clip",
                    "element": f"axes.{axes_index}",
                    "objects": clipped_diagram_objects[:12],
                    "count": len(clipped_diagram_objects),
                    "message": "网络图、路径图或 SEM 图元超出当前坐标范围，内容会被坐标轴裁掉。",
                    "suggestion": (
                        "请根据全部节点和路径的实际边界计算 xlim/ylim 并保留 padding；"
                        "扩大 Figure 白底画布不能恢复已被 axes clip 的内容。"
                    ),
                })
        return warnings
    except Exception:
        return []

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


class StreamplotContainer:
    """Semantic parent for the line and arrow artists emitted by streamplot."""

    def __init__(self, streamplot_set, axes, line_artist, arrow_artists):
        self.streamplot_set = streamplot_set
        self.axes = axes
        self.figure = axes.figure
        self.line_artist = line_artist
        self.arrow_artists = list(arrow_artists)

    def get_children(self):
        return [
            child
            for child in [self.line_artist, *self.arrow_artists]
            if child is not None
        ]

    def get_label(self):
        if self.line_artist is None:
            return ""
        return _safe_artist_label(self.line_artist, "")

    def get_zorder(self):
        if self.line_artist is None:
            return 0.0
        return self.line_artist.get_zorder()

# Monkey patch plotting calls whose returned artists do not retain enough
# class-level provenance for semantic introspection on every Matplotlib version.
original_boxplot = Axes.boxplot
original_violinplot = Axes.violinplot
original_fill_between = Axes.fill_between
original_contour = Axes.contour
original_contourf = Axes.contourf
original_hist = Axes.hist
original_stairs = Axes.stairs
original_step = Axes.step
original_pie = Axes.pie
original_quiver = Axes.quiver
original_streamplot = Axes.streamplot


def _plain_value(value):
    """Convert small structural plotting metadata to JSON-safe values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        try:
            return tolist()
        except Exception:
            pass
    if isinstance(value, (list, tuple)):
        return [_plain_value(item) for item in value]
    return value


_SCIFIGURE_DIAGRAM_GID_PREFIX = "scifigure-sem-v1:"
_DIAGRAM_TYPES = {"network", "path", "sem"}
_DIAGRAM_ROLE_MAP = {
    "node": "diagram_node",
    "edge": "diagram_edge",
    "arrow": "diagram_arrow",
    "node_label": "diagram_node_label",
    "coefficient_label": "diagram_coefficient_label",
    "fit_annotation": "diagram_fit_annotation",
    "group": "diagram_group",
}
_DIAGRAM_RELATION_FIELDS = (
    "diagramId",
    "diagramType",
    "diagramObjectId",
    "nodeId",
    "edgeId",
    "sourceNodeId",
    "targetNodeId",
)
_SPECIAL_AXES_RELATION_FIELDS = (
    "axesFamily",
    "projection",
    "parentSubplotId",
    "ownerSubplotId",
)
_LEGEND_MARKER_RELATION_FIELDS = (
    "subplotId",
    "legendId",
    "legendTextId",
    "parentId",
    "pieId",
    "pieSliceId",
    "quiverId",
    "streamplotId",
    "radarId",
    "radarSeriesId",
)
_SEMANTIC_PARENT_RELATION_FIELDS = (
    "subplotId",
    "parentId",
    "legendMarkerIds",
    "pieId",
    "pieSliceId",
    "pieLabelId",
    "pieValueLabelId",
    "sliceIndex",
    "quiverId",
    "streamplotId",
    "lineCollectionId",
    "radarId",
    "radarSemanticRole",
    "radarSeriesId",
    "radarDimensionIndex",
)
_SEMANTIC_PARENT_RELATION_TRIGGERS = tuple(
    field
    for field in _SEMANTIC_PARENT_RELATION_FIELDS
    if field not in {"subplotId", "parentId"}
)
_DIAGRAM_PROTECTED_TEXT_ROLES = {
    "diagram_node_label",
    "diagram_coefficient_label",
    "diagram_fit_annotation",
}
_DIAGRAM_STRUCTURAL_PROPS_BY_ROLE = {
    "diagram_node": {
        "diagram_id", "diagram_type", "node_id", "data", "x", "y",
    },
    "diagram_edge": {
        "diagram_id", "diagram_type", "edge_id", "source_node_id",
        "target_node_id", "direction", "path", "vertices", "control_points",
    },
    "diagram_arrow": {
        "diagram_id", "diagram_type", "edge_id", "source_node_id",
        "target_node_id", "direction", "path", "vertices", "control_points",
    },
    "diagram_node_label": {"text", "node_id"},
    "diagram_coefficient_label": {
        "text", "edge_id", "coefficient", "value", "p_value", "pvalue",
        "significance", "confidence_interval", "ci_low", "ci_high",
    },
    "diagram_fit_annotation": {
        "text", "fit", "fit_indices", "cfi", "tli", "rmsea", "srmr",
        "aic", "bic", "chi_square", "p_value", "pvalue",
    },
    "diagram_group": {"diagram_id", "diagram_type", "members", "node_ids"},
}


def _semantic_identifier(value: Any, field: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{field} must be a non-empty identifier")
    if len(text) > 256 or re.search(r"[\x00-\x1f\x7f]", text):
        raise ValueError(f"{field} contains unsupported characters or is too long")
    return text


def _diagram_semantic_fields(
    diagram_id: Any,
    role: Any,
    object_id: Any,
    *,
    diagram_type: Any = "sem",
    node_id: Any = None,
    edge_id: Any = None,
    source_node_id: Any = None,
    target_node_id: Any = None,
) -> dict:
    diagram_id_text = _semantic_identifier(diagram_id, "diagram_id")
    role_text = _semantic_identifier(role, "role").lower()
    object_id_text = _semantic_identifier(object_id, "object_id")
    diagram_type_text = _semantic_identifier(diagram_type, "diagram_type").lower()
    if role_text not in _DIAGRAM_ROLE_MAP:
        raise ValueError(f"unsupported diagram role: {role_text}")
    if diagram_type_text not in _DIAGRAM_TYPES:
        raise ValueError(f"unsupported diagram_type: {diagram_type_text}")

    optional = {
        "nodeId": _semantic_identifier(node_id, "node_id") if node_id is not None else None,
        "edgeId": _semantic_identifier(edge_id, "edge_id") if edge_id is not None else None,
        "sourceNodeId": _semantic_identifier(source_node_id, "source_node_id") if source_node_id is not None else None,
        "targetNodeId": _semantic_identifier(target_node_id, "target_node_id") if target_node_id is not None else None,
    }
    if role_text == "node":
        optional["nodeId"] = object_id_text
    elif role_text == "edge":
        optional["edgeId"] = object_id_text
        if not optional["sourceNodeId"] or not optional["targetNodeId"]:
            raise ValueError("edge semantics require source_node_id and target_node_id")
    elif role_text == "arrow" and not optional["edgeId"]:
        raise ValueError("arrow semantics require edge_id")
    elif role_text == "node_label" and not optional["nodeId"]:
        raise ValueError("node_label semantics require node_id")
    elif role_text == "coefficient_label" and not optional["edgeId"]:
        raise ValueError("coefficient_label semantics require edge_id")

    return {
        "family": "diagram",
        "callName": "SciFigure.semantic_gid",
        "semanticRole": _DIAGRAM_ROLE_MAP[role_text],
        "diagramRole": role_text,
        "diagramId": diagram_id_text,
        "diagramType": diagram_type_text,
        "diagramObjectId": object_id_text,
        **{key: value for key, value in optional.items() if value is not None},
    }


def _scifigure_semantic_gid(
    diagram_id: Any,
    role: Any,
    object_id: Any,
    *,
    diagram_type: Any = "sem",
    node_id: Any = None,
    edge_id: Any = None,
    source_node_id: Any = None,
    target_node_id: Any = None,
) -> str:
    fields = _diagram_semantic_fields(
        diagram_id,
        role,
        object_id,
        diagram_type=diagram_type,
        node_id=node_id,
        edge_id=edge_id,
        source_node_id=source_node_id,
        target_node_id=target_node_id,
    )
    query = {
        "diagram": fields["diagramId"],
        "type": fields["diagramType"],
        "role": fields["diagramRole"],
        "id": fields["diagramObjectId"],
    }
    for field, query_name in (
        ("nodeId", "node"),
        ("edgeId", "edge"),
        ("sourceNodeId", "source"),
        ("targetNodeId", "target"),
    ):
        if fields.get(field) is not None:
            query[query_name] = fields[field]
    return _SCIFIGURE_DIAGRAM_GID_PREFIX + urlencode(query)


def _parse_scifigure_semantic_gid(value: Any) -> Optional[dict]:
    if not isinstance(value, str) or not value.startswith(_SCIFIGURE_DIAGRAM_GID_PREFIX):
        return None
    try:
        parsed = parse_qs(
            value[len(_SCIFIGURE_DIAGRAM_GID_PREFIX):],
            keep_blank_values=True,
            strict_parsing=True,
        )
        if any(len(values) != 1 for values in parsed.values()):
            return None
        single = {key: values[0] for key, values in parsed.items()}
        return _diagram_semantic_fields(
            single.get("diagram"),
            single.get("role"),
            single.get("id"),
            diagram_type=single.get("type", "sem"),
            node_id=single.get("node"),
            edge_id=single.get("edge"),
            source_node_id=single.get("source"),
            target_node_id=single.get("target"),
        )
    except (TypeError, ValueError):
        return None


def _register_explicit_diagram_artist(artist: Any) -> Optional[dict]:
    existing = _intercepted_complex_artists.get(artist)
    if existing and existing.get("family") == "diagram":
        return existing
    getter = getattr(artist, "get_gid", None)
    marker = getter() if callable(getter) else None
    metadata = _parse_scifigure_semantic_gid(marker)
    if metadata is None:
        return existing
    metadata["axes"] = getattr(artist, "axes", None)
    _intercepted_complex_artists[artist] = metadata
    return metadata


def _apply_diagram_metadata_to_object(obj: dict, artist: Any) -> None:
    provenance = _register_explicit_diagram_artist(artist)
    if not provenance or provenance.get("family") != "diagram":
        return
    for field in _DIAGRAM_RELATION_FIELDS:
        if provenance.get(field) is not None:
            obj[field] = provenance[field]


def _diagram_relation_signature(identity: Any) -> Optional[dict]:
    if not isinstance(identity, dict):
        return None
    relation = identity.get("relation")
    if not isinstance(relation, dict):
        return None
    if not any(field in relation for field in _DIAGRAM_RELATION_FIELDS):
        return None
    return {
        field: _plain_value(relation.get(field)) if field in relation else None
        for field in _DIAGRAM_RELATION_FIELDS
    }


def _special_axes_relation_signature(identity: Any) -> Optional[dict]:
    if not isinstance(identity, dict):
        return None
    relation = identity.get("relation")
    if not isinstance(relation, dict) or "axesFamily" not in relation:
        return None
    return {
        field: _plain_value(relation.get(field)) if field in relation else None
        for field in _SPECIAL_AXES_RELATION_FIELDS
    }


def _legend_marker_relation_signature(identity: Any) -> Optional[dict]:
    if not isinstance(identity, dict):
        return None
    relation = identity.get("relation")
    if not isinstance(relation, dict) or "legendId" not in relation:
        return None
    return {
        field: _plain_value(relation.get(field)) if field in relation else None
        for field in _LEGEND_MARKER_RELATION_FIELDS
    }


def _semantic_parent_relation_signature(identity: Any) -> Optional[dict]:
    if not isinstance(identity, dict):
        return None
    relation = identity.get("relation")
    if not isinstance(relation, dict) or "legendId" in relation:
        return None
    if not any(field in relation for field in _SEMANTIC_PARENT_RELATION_TRIGGERS):
        return None
    return {
        field: _plain_value(relation.get(field)) if field in relation else None
        for field in _SEMANTIC_PARENT_RELATION_FIELDS
    }


def _is_diagram_structural_prop(artist: Any, prop: str) -> bool:
    provenance = _register_explicit_diagram_artist(artist)
    role = provenance.get("semanticRole") if provenance else None
    return str(prop).lower() in _DIAGRAM_STRUCTURAL_PROPS_BY_ROLE.get(role, set())


def _next_complex_call_index(axes, family: str, field: str) -> int:
    return 1 + max(
        [
            int(provenance.get(field, -1))
            for provenance in _intercepted_complex_artists.values()
            if provenance.get("axes") is axes and provenance.get("family") == family
        ],
        default=-1,
    )


def _axes_index(axes) -> int:
    try:
        return list(axes.figure.axes).index(axes)
    except (AttributeError, ValueError):
        return 0


def _histogram_series_artists(patches) -> list:
    if isinstance(patches, matplotlib.container.BarContainer):
        return [patches]
    try:
        from matplotlib.patches import Patch
        if isinstance(patches, Patch):
            return [patches]
    except Exception:
        pass
    try:
        result = []
        for item in list(patches):
            result.extend(_histogram_series_artists(item))
        return result
    except TypeError:
        return []


def _histogram_label(label_arg, index: int, artist) -> Optional[str]:
    if isinstance(label_arg, str):
        return label_arg if index == 0 else None
    if isinstance(label_arg, (list, tuple)) and index < len(label_arg):
        label = label_arg[index]
        return str(label) if label is not None else None
    candidates = list(getattr(artist, "patches", []) or []) or [artist]
    for child in candidates:
        label = _safe_artist_label(child, "")
        if label and not label.startswith("_"):
            return label
    return None

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

def patched_fill_between(self, *args, **kwargs):
    artist = original_fill_between(self, *args, **kwargs)
    _intercepted_complex_artists[artist] = {
        "axes": self,
        "family": "fill_between",
        "callName": "Axes.fill_between",
    }
    return artist

def _register_contour_set(artist, axes, family, call_name, kwargs):
    linewidth = kwargs.get("linewidths")
    linestyle = kwargs.get("linestyles")
    _intercepted_complex_artists[artist] = {
        "axes": axes,
        "family": family,
        "callName": call_name,
        "linewidth": linewidth,
        "linestyle": linestyle,
    }
    return artist

def patched_contour(self, *args, **kwargs):
    artist = original_contour(self, *args, **kwargs)
    return _register_contour_set(artist, self, "contour", "Axes.contour", kwargs)

def patched_contourf(self, *args, **kwargs):
    artist = original_contourf(self, *args, **kwargs)
    return _register_contour_set(artist, self, "contourf", "Axes.contourf", kwargs)


def patched_hist(self, *args, **kwargs):
    result = original_hist(self, *args, **kwargs)
    counts, edges, patches = result
    series_artists = _histogram_series_artists(patches)
    plain_counts = _plain_value(counts)
    plain_edges = _plain_value(edges)
    for index, artist in enumerate(series_artists):
        series_counts = plain_counts
        if (
            len(series_artists) > 1
            and isinstance(plain_counts, list)
            and index < len(plain_counts)
        ):
            series_counts = plain_counts[index]
        _intercepted_complex_artists[artist] = {
            "axes": self,
            "family": "hist",
            "callName": "Axes.hist",
            "counts": series_counts,
            "bins": plain_edges,
            "density": bool(kwargs.get("density", False)),
            "cumulative": _plain_value(kwargs.get("cumulative", False)),
            "orientation": str(kwargs.get("orientation", "vertical")),
            "histtype": str(kwargs.get("histtype", "bar")),
            "weighted": kwargs.get("weights") is not None,
            "legendLabel": _histogram_label(kwargs.get("label"), index, artist),
        }
    return result


def patched_stairs(self, *args, **kwargs):
    artist = original_stairs(self, *args, **kwargs)
    data = artist.get_data() if callable(getattr(artist, "get_data", None)) else None
    _intercepted_complex_artists[artist] = {
        "axes": self,
        "family": "stairs",
        "callName": "Axes.stairs",
        "values": _plain_value(getattr(data, "values", None)),
        "edges": _plain_value(getattr(data, "edges", None)),
        "baseline": _plain_value(getattr(data, "baseline", None)),
    }
    return artist


def patched_step(self, *args, **kwargs):
    artists = original_step(self, *args, **kwargs)
    for artist in artists:
        drawstyle = str(artist.get_drawstyle())
        where = drawstyle[len("steps-"):] if drawstyle.startswith("steps-") else kwargs.get("where", "pre")
        _intercepted_complex_artists[artist] = {
            "axes": self,
            "family": "step",
            "callName": "Axes.step",
            "where": str(where),
            "drawstyle": drawstyle,
        }
    return artists


def _pie_result_parts(result: Any) -> tuple[list[Any], list[Any], list[Any]]:
    """Normalize legacy tuple and Matplotlib 3.11+ ``PieContainer`` results."""
    container_wedges = getattr(result, "wedges", None)
    if container_wedges is not None:
        wedges = list(container_wedges)
        text_groups = list(getattr(result, "texts", None) or [])
        if text_groups and isinstance(text_groups[0], (list, tuple)):
            label_texts = list(text_groups[0])
            value_texts = list(text_groups[1]) if len(text_groups) > 1 else []
        else:
            label_texts = text_groups
            value_texts = []
        return wedges, label_texts, value_texts

    try:
        parts = list(result or [])
    except TypeError:
        parts = []
    wedges = list(parts[0]) if len(parts) > 0 else []
    label_texts = list(parts[1]) if len(parts) > 1 else []
    value_texts = list(parts[2]) if len(parts) > 2 else []
    return wedges, label_texts, value_texts


def patched_pie(self, *args, **kwargs):
    result = original_pie(self, *args, **kwargs)
    wedges, label_texts, value_texts = _pie_result_parts(result)
    values_arg = args[0] if args else kwargs.get("x", [])
    values = _plain_value(values_arg)
    if not isinstance(values, list):
        try:
            values = list(values)
        except TypeError:
            values = []
    explode = _plain_value(kwargs.get("explode"))
    if not isinstance(explode, list):
        explode = [0.0] * len(wedges)
    pie_call_index = 1 + max(
        [
            int(provenance.get("pieCallIndex", -1))
            for provenance in _intercepted_complex_artists.values()
            if provenance.get("axes") is self and provenance.get("family") == "pie"
        ],
        default=-1,
    )
    try:
        axes_index = list(self.figure.axes).index(self)
    except (AttributeError, ValueError):
        axes_index = 0
    pie_id = f"pie.{axes_index}.{pie_call_index}"

    for index, wedge in enumerate(wedges):
        label_artist = label_texts[index] if index < len(label_texts) else None
        value_artist = value_texts[index] if index < len(value_texts) else None
        label = label_artist.get_text() if label_artist is not None else _safe_artist_label(wedge, "")
        provenance = {
            "axes": self,
            "family": "pie",
            "callName": "Axes.pie",
            "semanticRole": "pie_slice",
            "pieId": pie_id,
            "pieCallIndex": pie_call_index,
            "sliceIndex": index,
            "values": values,
            "value": values[index] if index < len(values) else None,
            "explode": explode[index] if index < len(explode) else 0.0,
            "startangle": kwargs.get("startangle", 0.0),
            "counterclock": kwargs.get("counterclock", True),
            "normalize": kwargs.get("normalize", True),
            "labeldistance": kwargs.get("labeldistance", 1.1),
            "pctdistance": kwargs.get("pctdistance", 0.6),
            "labelArtist": label_artist,
            "valueLabelArtist": value_artist,
            "legendLabel": label,
        }
        _intercepted_complex_artists[wedge] = provenance
        if label_artist is not None:
            _intercepted_complex_artists[label_artist] = {
                **provenance,
                "semanticRole": "pie_label",
                "sliceArtist": wedge,
            }
        if value_artist is not None:
            _intercepted_complex_artists[value_artist] = {
                **provenance,
                "semanticRole": "pie_value_label",
                "sliceArtist": wedge,
            }
    return result


def patched_quiver(self, *args, **kwargs):
    artist = original_quiver(self, *args, **kwargs)
    call_index = _next_complex_call_index(self, "quiver", "quiverCallIndex")
    axes_index = _axes_index(self)
    _intercepted_complex_artists[artist] = {
        "axes": self,
        "family": "quiver",
        "callName": "Axes.quiver",
        "semanticRole": "quiver_field",
        "quiverId": f"quiver.{axes_index}.{call_index}",
        "quiverCallIndex": call_index,
    }
    return artist


def patched_streamplot(self, *args, **kwargs):
    before_patches = set(self.patches)
    streamplot_set = original_streamplot(self, *args, **kwargs)
    line_artist = getattr(streamplot_set, "lines", None)
    returned_arrow_artist = getattr(streamplot_set, "arrows", None)
    try:
        from matplotlib.patches import FancyArrowPatch
        arrow_artists = [
            patch
            for patch in self.patches
            if patch not in before_patches and isinstance(patch, FancyArrowPatch)
        ]
    except Exception:
        arrow_artists = [patch for patch in self.patches if patch not in before_patches]
    if (
        returned_arrow_artist is not None
        and returned_arrow_artist is not line_artist
        and returned_arrow_artist in self.collections
        and returned_arrow_artist not in arrow_artists
    ):
        arrow_artists.append(returned_arrow_artist)

    call_index = _next_complex_call_index(self, "streamplot", "streamplotCallIndex")
    axes_index = _axes_index(self)
    streamplot_id = f"container.streamplot.{axes_index}.{call_index}"
    container = StreamplotContainer(
        streamplot_set,
        self,
        line_artist,
        arrow_artists,
    )
    vector_shape = None
    if len(args) >= 4:
        vector_shape = list(getattr(args[2], "shape", []) or getattr(args[3], "shape", []))
    provenance = {
        "axes": self,
        "family": "streamplot",
        "callName": "Axes.streamplot",
        "streamplotId": streamplot_id,
        "streamplotCallIndex": call_index,
        "lineArtist": line_artist,
        "arrowArtists": arrow_artists,
        "density": _plain_value(kwargs.get("density", 1.0)),
        "startPointsProvided": kwargs.get("start_points") is not None,
        "integrationDirection": str(kwargs.get("integration_direction", "both")),
        "maxlength": _plain_value(kwargs.get("maxlength", 4.0)),
        "minlength": _plain_value(kwargs.get("minlength", 0.1)),
        "brokenStreamlines": bool(kwargs.get("broken_streamlines", True)),
        "vectorShape": vector_shape,
    }
    _intercepted_complex_artists[container] = {
        **provenance,
        "semanticRole": "streamplot_field",
    }
    if line_artist is not None:
        _intercepted_complex_artists[line_artist] = {
            **provenance,
            "semanticRole": "streamplot_child_line",
            "streamplotContainer": container,
        }
    for arrow_artist in arrow_artists:
        _intercepted_complex_artists[arrow_artist] = {
            **provenance,
            "semanticRole": "streamplot_child_arrow",
            "streamplotContainer": container,
        }
    return streamplot_set

Axes.boxplot = patched_boxplot
Axes.violinplot = patched_violinplot
Axes.fill_between = patched_fill_between
Axes.contour = patched_contour
Axes.contourf = patched_contourf
Axes.hist = patched_hist
Axes.stairs = patched_stairs
Axes.step = patched_step
Axes.pie = patched_pie
Axes.quiver = patched_quiver
Axes.streamplot = patched_streamplot


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

_SPECIAL_AXES_PANEL_KINDS = {
    "polar_subplot",
    "three_d_subplot",
    "inset_subplot",
    "geo_subplot",
    "parasite_subplot",
    "unsupported_axes",
    "brokenaxes_group",
}

_DATA_PANEL_KINDS = {"subplot", *_SPECIAL_AXES_PANEL_KINDS}


def _safe_axes_position_bounds(ax) -> Optional[tuple[float, float, float, float]]:
    try:
        bounds = ax.get_position().bounds
        return tuple(float(value) for value in bounds)
    except Exception:
        pass

    for attr_name in ("_position", "_originalPosition"):
        bbox = getattr(ax, attr_name, None)
        bounds = getattr(bbox, "bounds", None)
        if bounds is None:
            continue
        try:
            return tuple(float(value) for value in bounds)
        except Exception:
            continue
    return None


def _install_safe_position_fallback(ax, bounds) -> None:
    if bounds is None or getattr(ax, "_scifigure_position_fallback", False):
        return
    try:
        from matplotlib.transforms import Bbox

        fallback_bbox = Bbox.from_bounds(*bounds)

        def safe_get_position(original=False):
            source = getattr(ax, "_originalPosition", None) if original else getattr(ax, "_position", None)
            return source if getattr(source, "bounds", None) is not None else fallback_bbox

        setattr(ax, "_scifigure_original_get_position", getattr(ax, "get_position", None))
        setattr(ax, "_scifigure_position_fallback", True)
        ax.get_position = safe_get_position
    except Exception:
        pass


def _axes_projection_name(ax) -> str:
    projection = getattr(ax, "name", None)
    if isinstance(projection, str) and projection:
        return projection
    return type(ax).__name__


def _axes_locator_module(ax) -> str:
    try:
        locator = ax.get_axes_locator()
    except Exception:
        locator = None
    return type(locator).__module__.lower() if locator is not None else ""


def _classify_axes_family(ax, parent_axes=None) -> str:
    module = type(ax).__module__.lower()
    class_name = type(ax).__name__.lower()
    projection = _axes_projection_name(ax).lower()
    locator_module = _axes_locator_module(ax)

    if _is_colorbar_axes(ax):
        return "colorbar"
    if "secondaryaxis" in class_name or "_secondary_axes" in module:
        orientation = str(getattr(ax, "_orientation", "")).lower()
        return "secondary_x" if orientation == "x" else "secondary_y"
    if parent_axes is not None and "parasite" not in class_name:
        return "inset"
    if "inset_locator" in locator_module:
        return "inset"
    if "geoaxes" in class_name or module.startswith("cartopy."):
        return "geo"
    if projection == "polar" or "polaraxes" in class_name:
        return "polar"
    if projection == "3d" or "axes3d" in class_name:
        return "3d"
    if "parasite" in module or "parasite" in class_name or "hostaxes" in class_name:
        return "parasite" if parent_axes is not None or "axesparasite" in class_name else "parasite_host"
    if "brokenaxes" in module or "brokenaxes" in class_name:
        return "broken"
    if projection not in {"rectilinear", ""}:
        return "unsupported"
    return "cartesian"


def _axes_panel_contract(family: str, index: int) -> tuple[Optional[str], Optional[str], Optional[str]]:
    if family == "cartesian":
        return f"subplot.{index}", "subplot", "subplot_panel"
    contracts = {
        "polar": ("polar_subplot", "polar_subplot", "polar_subplot_panel"),
        "3d": ("three_d_subplot", "three_d_subplot", "three_d_subplot_panel"),
        "inset": ("inset_subplot", "inset_subplot", "inset_subplot_panel"),
        "geo": ("geo_subplot", "geo_subplot", "geo_subplot_panel"),
        "parasite_host": ("parasite_subplot", "parasite_subplot", "parasite_host_panel"),
        "unsupported": ("unsupported_axes", "unsupported_axes", "unsupported_projection_panel"),
        "broken": ("brokenaxes_group", "brokenaxes_group", "brokenaxes_panel_group"),
        "parasite": ("parasite_axis", "parasite_axis", "parasite_axis"),
        "secondary_x": ("secondary_xaxis", "secondary_xaxis", "secondary_x_axis"),
        "secondary_y": ("secondary_yaxis", "secondary_yaxis", "secondary_y_axis"),
    }
    contract = contracts.get(family)
    if contract is None:
        return None, None, None
    prefix, kind, role = contract
    return f"{prefix}.{index}", kind, role


def _bounds_contains(parent_bounds, child_bounds, tolerance: float = 1e-6) -> bool:
    if parent_bounds is None or child_bounds is None:
        return False
    px, py, pw, ph = parent_bounds
    cx, cy, cw, ch = child_bounds
    return (
        cx >= px - tolerance
        and cy >= py - tolerance
        and cx + cw <= px + pw + tolerance
        and cy + ch <= py + ph + tolerance
        and pw * ph > cw * ch + tolerance
    )


def _build_axes_contexts(fig) -> list[dict[str, Any]]:
    contexts: list[dict[str, Any]] = []
    seen = set()

    def add_context(ax, parent_axes=None, source_index=None):
        if ax is None or id(ax) in seen:
            return None
        seen.add(id(ax))
        if source_index is None:
            source_index = len(contexts)
        context = {
            "axes": ax,
            "axesIndex": int(source_index),
            "parentAxes": parent_axes,
            "family": _classify_axes_family(ax, parent_axes),
            "projection": _axes_projection_name(ax),
            "degradedReason": None,
        }
        try:
            ax.get_position()
        except Exception as exc:
            fallback_bounds = _safe_axes_position_bounds(ax) or (0.125, 0.11, 0.775, 0.77)
            _install_safe_position_fallback(ax, fallback_bounds)
            context["family"] = "unsupported"
            context["degradedReason"] = f"Axes position lookup failed: {type(exc).__name__}: {exc}"
        contexts.append(context)
        return context

    for source_index, ax in enumerate(list(getattr(fig, "axes", []) or [])):
        add_context(ax, source_index=source_index)

    cursor = 0
    while cursor < len(contexts):
        context = contexts[cursor]
        cursor += 1
        ax = context["axes"]
        children = list(getattr(ax, "child_axes", []) or [])
        children.extend(list(getattr(ax, "parasites", []) or []))
        for child in children:
            add_context(child, parent_axes=ax)

    # Toolkit-created inset axes can live in fig.axes without an explicit
    # parent pointer. Infer only for objects already classified by their inset
    # locator; ordinary manually positioned axes remain independent subplots.
    for context in contexts:
        if context["family"] != "inset" or context.get("parentAxes") is not None:
            continue
        child_bounds = _safe_axes_position_bounds(context["axes"])
        candidates = []
        for candidate in contexts:
            if candidate is context or candidate["family"] in {"colorbar", "inset", "secondary_x", "secondary_y", "parasite"}:
                continue
            parent_bounds = _safe_axes_position_bounds(candidate["axes"])
            if _bounds_contains(parent_bounds, child_bounds):
                candidates.append((parent_bounds[2] * parent_bounds[3], candidate["axes"]))
        if candidates:
            context["parentAxes"] = min(candidates, key=lambda item: item[0])[1]

    family_counts: dict[str, int] = {}
    for context in contexts:
        family = context["family"]
        family_index = family_counts.get(family, 0)
        family_counts[family] = family_index + 1
        panel_index = context["axesIndex"] if family == "cartesian" else family_index
        panel_gid, panel_kind, panel_role = _axes_panel_contract(family, panel_index)
        context.update({
            "panelGid": panel_gid,
            "panelKind": panel_kind,
            "panelRole": panel_role,
        })

    context_by_axes = {context["axes"]: context for context in contexts}
    for context in contexts:
        parent = context_by_axes.get(context.get("parentAxes"))
        context["parentPanelGid"] = parent.get("panelGid") if parent else None
        if context["family"] in {"secondary_x", "secondary_y", "parasite"}:
            context["scopeSubplotId"] = context["parentPanelGid"]
        else:
            context["scopeSubplotId"] = context.get("panelGid")
        try:
            setattr(context["axes"], "_scifigure_axes_context", context)
        except Exception:
            pass
    return contexts


def _axes_context_for_artist(artist) -> Optional[dict[str, Any]]:
    axes = artist if isinstance(artist, Axes) or hasattr(artist, "_scifigure_axes_context") else getattr(artist, "axes", None)
    context = getattr(axes, "_scifigure_axes_context", None)
    return context if isinstance(context, dict) else None


def _bind_raw_element_axes_contexts(raw_elements) -> None:
    contexts_by_index = {}
    for gid, kind, artist in raw_elements:
        if kind != "axes":
            continue
        context = _axes_context_for_artist(artist)
        if context:
            contexts_by_index[int(context["axesIndex"])] = context
    for gid, _, artist in raw_elements:
        direct_context = getattr(artist, "__dict__", {}).get("_scifigure_axes_context")
        context = direct_context if isinstance(direct_context, dict) else contexts_by_index.get(_axes_index_from_gid(gid))
        if not context:
            continue
        try:
            setattr(artist, "_scifigure_axes_context", context)
        except Exception:
            pass


def _ordered_spines(ax):
    spines = getattr(ax, "spines", {})
    ordered_names = [name for name in ("left", "right", "top", "bottom") if name in spines]
    ordered_names.extend(name for name in spines if name not in ordered_names)
    return [(name, spines[name]) for name in ordered_names]


def _iter_axes_legends(ax):
    """Yield the primary Axes legend first, then legends retained via add_artist()."""
    primary = ax.get_legend()
    if primary is not None:
        yield None, primary

    try:
        from matplotlib.legend import Legend
    except Exception:
        return

    extra_index = 0
    for artist in list(getattr(ax, "artists", []) or []):
        if not isinstance(artist, Legend) or artist is primary:
            continue
        yield extra_index, artist
        extra_index += 1


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

    for axes_context in _build_axes_contexts(fig):
        ax_idx = axes_context["axesIndex"]
        ax = axes_context["axes"]
        # Freeze ticks so that their `gid` and properties are preserved during savefig
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                _freeze_ticklabels_preserving_style(ax)
            except Exception:
                pass

        yield f"axes.{ax_idx}", "axes", ax
        try:
            ax.patch.set_gid(f"axes.patch.{ax_idx}")
        except Exception:
            pass
        if axes_context.get("panelGid") and axes_context.get("panelKind"):
            yield axes_context["panelGid"], axes_context["panelKind"], ax
        
        # Yield containers
        for c_idx, container in enumerate(getattr(ax, "containers", []) or []):
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
        xaxis = getattr(ax, "xaxis", None)
        yaxis = getattr(ax, "yaxis", None)
        zaxis = getattr(ax, "zaxis", None)
        if xaxis is not None:
            for i, line in enumerate(xaxis.get_gridlines()):
                yield f"grid.{ax_idx}.line.x.{i}", "grid_line", line
        if yaxis is not None:
            for i, line in enumerate(yaxis.get_gridlines()):
                yield f"grid.{ax_idx}.line.y.{i}", "grid_line", line
        yield f"spine_group.{ax_idx}", "spine_group", ax
        if xaxis is not None:
            yield f"axis.x.{ax_idx}", "axis_x", xaxis
        if yaxis is not None:
            yield f"axis.y.{ax_idx}", "axis_y", yaxis
        if zaxis is not None:
            yield f"axis.z.{ax_idx}", "axis_z", zaxis
        if ax.title is not None and ax.title.get_text():
            yield f"title.{ax_idx}", "text", ax.title
        if hasattr(ax, '_left_title') and ax._left_title and ax._left_title.get_text():
            yield f"title.left.{ax_idx}", "text", ax._left_title
        if hasattr(ax, '_right_title') and ax._right_title and ax._right_title.get_text():
            yield f"title.right.{ax_idx}", "text", ax._right_title
        if xaxis is not None:
            yield f"xlabel.{ax_idx}", "text", xaxis.label
        if yaxis is not None:
            yield f"ylabel.{ax_idx}", "text", yaxis.label
        if zaxis is not None:
            yield f"zlabel.{ax_idx}", "text", zaxis.label

        for side, spine in _ordered_spines(ax):
            yield f"spine.{side}.{ax_idx}", "spine", spine

        for i, label in enumerate(getattr(ax, "get_xticklabels", lambda: [])()):
            yield f"xtick.{ax_idx}.{i}", "text", label
        for i, label in enumerate(getattr(ax, "get_yticklabels", lambda: [])()):
            yield f"ytick.{ax_idx}.{i}", "text", label
        for i, label in enumerate(getattr(ax, "get_zticklabels", lambda: [])()):
            yield f"ztick.{ax_idx}.{i}", "text", label

        for extra_legend_idx, legend in _iter_axes_legends(ax):
            legend_suffix = (
                f"{ax_idx}"
                if extra_legend_idx is None
                else f"{ax_idx}.extra.{extra_legend_idx}"
            )
            yield f"legend.{legend_suffix}", "legend", legend
            title = legend.get_title()
            if title is not None:
                yield f"legend_title.{legend_suffix}", "text", title
            
            texts = legend.get_texts()
            for i, text in enumerate(texts):
                yield f"legend_text.{legend_suffix}.{i}", "text", text
            handles = _get_legend_handles(legend)
            handle_labels = {
                id(handle): texts[i].get_text()
                for i, handle in enumerate(handles)
                if i < len(texts)
            }
            for i, line in enumerate(legend.get_lines()):
                label = handle_labels.get(id(line))
                if label is not None:
                    line.set_label(label)
                yield f"legend_line.{legend_suffix}.{i}", "line", line
            for i, patch in enumerate(legend.get_patches()):
                label = handle_labels.get(id(patch))
                if label is not None:
                    patch.set_label(label)
                yield f"legend_patch.{legend_suffix}.{i}", "patch", patch
            for i, handle in enumerate(handles):
                if not _is_legend_collection_handle(handle):
                    continue
                label = handle_labels.get(id(handle))
                if label is not None:
                    handle.set_label(label)
                yield f"legend_collection.{legend_suffix}.{i}", "collection", handle

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

        for i, line in enumerate(getattr(ax, "lines", []) or []):
            yield f"line.{ax_idx}.{i}", "line", line

        contour_counts = {"contour": 0, "contourf": 0}
        for contour_set, provenance in _intercepted_complex_artists.items():
            family = provenance.get("family")
            if provenance.get("axes") is not ax or family not in contour_counts:
                continue
            contour_idx = contour_counts[family]
            contour_counts[family] += 1
            yield f"container.{family}.{ax_idx}.{contour_idx}", family, contour_set

        streamplot_idx = 0
        for streamplot_container, provenance in _intercepted_complex_artists.items():
            if (
                provenance.get("axes") is not ax
                or provenance.get("family") != "streamplot"
                or provenance.get("semanticRole") != "streamplot_field"
            ):
                continue
            yield (
                f"container.streamplot.{ax_idx}.{streamplot_idx}",
                "streamplot",
                streamplot_container,
            )
            streamplot_idx += 1

        for i, coll in enumerate(getattr(ax, "collections", []) or []):
            import matplotlib.collections as mcoll
            if isinstance(coll, mcoll.QuadMesh):
                yield f"heatmap.mesh.{ax_idx}.{i}", "heatmap", coll
            elif _intercepted_complex_artists.get(coll, {}).get("family") == "fill_between":
                # Preserve the historical collection GID while exposing a
                # dedicated semantic kind for controls and target resolution.
                yield f"collection.{ax_idx}.{i}", "fill_between", coll
            elif _intercepted_complex_artists.get(coll, {}).get("family") == "quiver":
                # Preserve legacy collection GIDs while preventing vector
                # fields from inheriting scatter size controls.
                yield f"collection.{ax_idx}.{i}", "quiver", coll
            else:
                yield f"collection.{ax_idx}.{i}", "collection", coll

        import matplotlib.image as mimage
        for i, img in enumerate(getattr(ax, "images", []) or []):
            if isinstance(img, mimage.AxesImage):
                yield f"heatmap.image.{ax_idx}.{i}", "heatmap", img

        cbar = getattr(ax, "_colorbar", None)
        if cbar is not None:
            yield f"colorbar.{ax_idx}", "colorbar", cbar

        # Build patch-to-container-label map
        patch_labels = {}
        for container in getattr(ax, "containers", []) or []:
            label = container.get_label()
            if label and not label.startswith('_nolegend_'):
                for child in getattr(container, 'patches', []):
                    patch_labels[child] = label
                try:
                    for child in container:
                        patch_labels[child] = label
                except TypeError:
                    pass

        for i, patch in enumerate(getattr(ax, "patches", []) or []):
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
        handles = _get_legend_handles(legend)
        handle_labels = {
            id(handle): texts[i].get_text()
            for i, handle in enumerate(handles)
            if i < len(texts)
        }
        for i, line in enumerate(legend.get_lines()):
            label = handle_labels.get(id(line))
            if label is not None:
                line.set_label(label)
            yield f"legend_line.figure.{fig_legend_idx}.{i}", "line", line
        for i, patch in enumerate(legend.get_patches()):
            label = handle_labels.get(id(patch))
            if label is not None:
                patch.set_label(label)
            yield f"legend_patch.figure.{fig_legend_idx}.{i}", "patch", patch
        for i, handle in enumerate(handles):
            if not _is_legend_collection_handle(handle):
                continue
            label = handle_labels.get(id(handle))
            if label is not None:
                handle.set_label(label)
            yield f"legend_collection.figure.{fig_legend_idx}.{i}", "collection", handle


_GENERIC_FONT_FAMILIES = {"serif", "sans-serif", "monospace", "cursive", "fantasy"}
_TIMES_COMPAT_REQUESTS = {"times new roman", "times"}
_TIMES_RUNTIME_CANDIDATES = ("Times New Roman", "Times", "Liberation Serif", "FreeSerif", "serif")
_FONT_FAMILY_FALLBACKS = {
    "times new roman": _TIMES_RUNTIME_CANDIDATES,
    "times": _TIMES_RUNTIME_CANDIDATES,
}
_FONT_FAMILY_RESOLUTION_CACHE: dict[str, str] = {}


def _font_name_for_family(family: str) -> Optional[str]:
    try:
        from matplotlib.font_manager import FontProperties, findfont

        path = findfont(FontProperties(family=[family]), fallback_to_default=False)
        return FontProperties(fname=path).get_name()
    except Exception:
        return None


def _font_family_available(family: str) -> bool:
    return _font_name_for_family(family) is not None


def _resolve_runtime_fontfamily(requested: Any) -> str:
    family = str(requested or "").strip()
    if not family:
        return family
    cache_key = family.casefold()
    cached = _FONT_FAMILY_RESOLUTION_CACHE.get(cache_key)
    if cached is not None:
        return cached
    resolved = family
    if not _font_family_available(family):
        for candidate in _FONT_FAMILY_FALLBACKS.get(cache_key, ()):
            if _font_family_available(candidate):
                resolved = candidate
                break
    _FONT_FAMILY_RESOLUTION_CACHE[cache_key] = resolved
    return resolved


def _resolve_font_family(value: Any) -> str:
    return _resolve_runtime_fontfamily(value)


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


def _text_fontfamily(text: Any) -> str:
    return _requested_fontfamily(text)


def _snapshot_text_style(text):
    bbox_patch = text.get_bbox_patch()
    bbox_style = None
    if bbox_patch is not None:
        try:
            boxstyle = bbox_patch.get_boxstyle()
            bbox_style = {
                "visible": bool(bbox_patch.get_visible()),
                "facecolor": bbox_patch.get_facecolor(),
                "edgecolor": bbox_patch.get_edgecolor(),
                "alpha": bbox_patch.get_alpha(),
                "linewidth": bbox_patch.get_linewidth(),
                "boxstyle": type(boxstyle).__name__.lower(),
                "pad": float(getattr(boxstyle, "pad", 0.3)),
            }
        except Exception:
            bbox_style = None
    return {
        "fontsize": text.get_fontsize(),
        "fontname": _requested_fontfamily(text),
        "requested_fontfamily": getattr(text, "_scifigure_requested_fontfamily", None),
        "color": text.get_color(),
        "rotation": text.get_rotation(),
        "ha": text.get_horizontalalignment(),
        "va": text.get_verticalalignment(),
        "visible": text.get_visible(),
        "fontweight": text.get_fontweight(),
        "fontstyle": text.get_fontstyle(),
        "bbox": bbox_style,
    }


def _restore_text_style(text, style: dict):
    try:
        text.set_fontsize(style["fontsize"])
        if style.get("requested_fontfamily"):
            _set_text_fontfamily(text, style["requested_fontfamily"])
        else:
            _set_text_fontfamily(text, style["fontname"])
        text.set_color(style["color"])
        text.set_rotation(style["rotation"])
        text.set_horizontalalignment(style["ha"])
        text.set_verticalalignment(style["va"])
        text.set_visible(style["visible"])
        text.set_fontweight(style.get("fontweight", "normal"))
        text.set_fontstyle(style.get("fontstyle", "normal"))
        bbox_style = style.get("bbox")
        if isinstance(bbox_style, dict):
            text.set_bbox({
                "boxstyle": f"{bbox_style.get('boxstyle', 'round')},pad={float(bbox_style.get('pad', 0.3))}",
                "facecolor": bbox_style.get("facecolor", "white"),
                "edgecolor": bbox_style.get("edgecolor", "black"),
                "linewidth": float(bbox_style.get("linewidth", 0.8)),
                **({"alpha": float(bbox_style["alpha"])} if bbox_style.get("alpha") is not None else {}),
            })
            text.get_bbox_patch().set_visible(bool(bbox_style.get("visible", True)))
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
    bbox_patch = artist.get_bbox_patch()
    bbox_boxstyle = "round"
    bbox_pad = 0.3
    if bbox_patch is not None:
        try:
            boxstyle = bbox_patch.get_boxstyle()
            bbox_boxstyle = type(boxstyle).__name__.lower()
            bbox_pad = float(getattr(boxstyle, "pad", bbox_pad))
        except Exception:
            pass
    bbox_alpha = 1.0
    if bbox_patch is not None:
        try:
            explicit_alpha = bbox_patch.get_alpha()
            bbox_alpha = float(
                explicit_alpha
                if explicit_alpha is not None
                else bbox_patch.get_facecolor()[3]
            )
        except Exception:
            pass
    props.update({
        "bbox_visible": bool(bbox_patch is not None and bbox_patch.get_visible()),
        "bbox_facecolor": to_hex_safe(bbox_patch.get_facecolor()) if bbox_patch is not None else "#ffffff",
        "bbox_edgecolor": to_hex_safe(bbox_patch.get_edgecolor()) if bbox_patch is not None else "#000000",
        "bbox_alpha": bbox_alpha,
        "bbox_linewidth": float(bbox_patch.get_linewidth()) if bbox_patch is not None else 0.8,
        "bbox_pad": bbox_pad,
        "bbox_boxstyle": bbox_boxstyle,
    })
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
    color = artist.get_color()
    if not isinstance(color, str):
        color = _first_color_hex(color) or _plain_value(color)
    props = {
        "color": color,
        "linewidth": artist.get_linewidth(),
        "linestyle": artist.get_linestyle(),
        "alpha": artist.get_alpha(),
        "marker": artist.get_marker(),
        "markersize": artist.get_markersize(),
    }
    provenance = _intercepted_complex_artists.get(artist, {})
    if provenance.get("family") == "step":
        props["where"] = provenance.get("where", "pre")
        props["drawstyle"] = provenance.get("drawstyle", artist.get_drawstyle())
    return props


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
    try:
        size_scale = float(getattr(artist, "_scifigure_size_scale", 1.0))
        if size_scale <= 0:
            size_scale = 1.0
    except Exception:
        size_scale = 1.0
    props = {
        "facecolor": fc.tolist() if hasattr(fc, "tolist") else fc,
        "edgecolor": ec.tolist() if hasattr(ec, "tolist") else ec,
        "alpha": artist.get_alpha(),
        "linewidth": linewidth,
        "size": size,
        "sizes": sizes_list,
        "size_scale": size_scale,
    }
    if _intercepted_complex_artists.get(artist, {}).get("semanticRole") == "streamplot_child_line":
        colors = getattr(artist, "get_colors", lambda: [])()
        try:
            if len(colors) > 0:
                props["color"] = mcolors.to_hex(colors[0], keep_alpha=False)
        except Exception:
            pass
    return props


def _first_color_hex(value: Any) -> Optional[str]:
    try:
        rows = value.tolist() if hasattr(value, "tolist") else value
        if isinstance(rows, (list, tuple)) and rows and isinstance(rows[0], (list, tuple)):
            rows = rows[0]
        return mcolors.to_hex(rows, keep_alpha=False)
    except Exception:
        return None


def _read_quiver_props(artist) -> dict:
    props = _read_collection_props(artist)
    color = _first_color_hex(artist.get_facecolor()) or _first_color_hex(artist.get_edgecolor())
    props.update({
        "color": color,
        "visible": bool(artist.get_visible()),
        "vectorCount": int(getattr(artist, "N", 0) or 0),
        "scale": _plain_value(getattr(artist, "scale", None)),
        "scale_units": _plain_value(getattr(artist, "scale_units", None)),
        "angles": _plain_value(getattr(artist, "angles", None)),
        "pivot": _plain_value(getattr(artist, "pivot", None)),
        "units": _plain_value(getattr(artist, "units", None)),
        "width": _plain_value(getattr(artist, "width", None)),
        "headwidth": _plain_value(getattr(artist, "headwidth", None)),
        "headlength": _plain_value(getattr(artist, "headlength", None)),
        "headaxislength": _plain_value(getattr(artist, "headaxislength", None)),
        "minshaft": _plain_value(getattr(artist, "minshaft", None)),
        "minlength": _plain_value(getattr(artist, "minlength", None)),
    })
    props.pop("size", None)
    props.pop("sizes", None)
    props.pop("size_scale", None)
    return props


def _read_streamplot_props(container) -> dict:
    provenance = _intercepted_complex_artists.get(container, {})
    line = container.line_artist
    arrows = container.arrow_artists
    color = None
    linewidth = None
    alpha = None
    visible = True
    zorder = None
    if line is not None:
        colors = getattr(line, "get_colors", lambda: [])()
        try:
            if len(colors) > 0:
                color = mcolors.to_hex(colors[0], keep_alpha=False)
        except Exception:
            pass
        widths = getattr(line, "get_linewidths", lambda: [])()
        try:
            if len(widths) > 0:
                linewidth = float(widths[0])
        except Exception:
            pass
        alpha = line.get_alpha()
        visible = bool(line.get_visible()) and all(bool(arrow.get_visible()) for arrow in arrows)
        zorder = float(line.get_zorder())
    return {
        "color": color,
        "alpha": alpha,
        "linewidth": linewidth,
        "visible": visible,
        "zorder": zorder,
        "density": provenance.get("density"),
        "start_points": provenance.get("startPointsProvided", False),
        "integration_direction": provenance.get("integrationDirection"),
        "maxlength": provenance.get("maxlength"),
        "minlength": provenance.get("minlength"),
        "broken_streamlines": provenance.get("brokenStreamlines"),
        "vectorShape": provenance.get("vectorShape"),
        "arrowCount": len(arrows),
    }


def _read_fill_between_props(artist) -> dict:
    props = _read_collection_props(artist)
    return {
        key: props.get(key)
        for key in ("facecolor", "edgecolor", "alpha", "linewidth")
    }


def _read_histogram_structure(provenance: dict) -> dict:
    return {
        "bins": provenance.get("bins"),
        "counts": provenance.get("counts"),
        "density": provenance.get("density", False),
        "cumulative": provenance.get("cumulative", False),
        "orientation": provenance.get("orientation", "vertical"),
        "histtype": provenance.get("histtype", "bar"),
        "weighted": provenance.get("weighted", False),
    }


def _read_patch_props(artist) -> dict:
    fc = artist.get_facecolor()
    ec = artist.get_edgecolor()
    props = {
        "facecolor": fc.tolist() if hasattr(fc, "tolist") else list(fc) if isinstance(fc, tuple) else fc,
        "edgecolor": ec.tolist() if hasattr(ec, "tolist") else list(ec) if isinstance(ec, tuple) else ec,
        "alpha": artist.get_alpha(),
        "linewidth": artist.get_linewidth(),
    }
    provenance = _intercepted_complex_artists.get(artist, {})
    if provenance.get("semanticRole") == "streamplot_child_arrow":
        props["facecolor"] = _first_color_hex(fc)
        props["edgecolor"] = _first_color_hex(ec)
    if provenance.get("family") == "hist":
        props.update(_read_histogram_structure(provenance))
    elif provenance.get("family") == "stairs":
        data = artist.get_data() if callable(getattr(artist, "get_data", None)) else None
        props.update({
            "values": _plain_value(getattr(data, "values", provenance.get("values"))),
            "edges": _plain_value(getattr(data, "edges", provenance.get("edges"))),
            "baseline": _plain_value(getattr(data, "baseline", provenance.get("baseline"))),
        })
    try:
        from matplotlib.patches import Wedge
        if isinstance(artist, Wedge):
            props.update({
                "center": [float(value) for value in artist.center],
                "radius": float(artist.r),
                "theta1": float(artist.theta1),
                "theta2": float(artist.theta2),
                "width": None if artist.width is None else float(artist.width),
            })
            if provenance.get("family") == "pie":
                angle_fraction = abs(float(artist.theta2) - float(artist.theta1)) / 360.0
                props.update({
                    "values": _plain_value(provenance.get("values")),
                    "value": _plain_value(provenance.get("value")),
                    "fraction": angle_fraction,
                    "explode": _plain_value(provenance.get("explode", 0.0)),
                    "startangle": float(provenance.get("startangle", 0.0)),
                    "counterclock": bool(provenance.get("counterclock", True)),
                    "normalize": bool(provenance.get("normalize", True)),
                    "labeldistance": _plain_value(provenance.get("labeldistance")),
                    "pctdistance": _plain_value(provenance.get("pctdistance")),
                })
    except Exception:
        pass
    return props


def _read_axes_props(artist) -> dict:
    try:
        xlim = list(artist.get_xlim())
    except Exception:
        xlim = []
    try:
        ylim = list(artist.get_ylim())
    except Exception:
        ylim = []
    
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
    bounds = _safe_axes_position_bounds(artist)
    if bounds is None:
        return {
            "specialAxesUnsupportedReason": "Axes bounds are unavailable; layout editing is disabled.",
        }
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


def _read_special_axes_props(artist) -> dict:
    context = _axes_context_for_artist(artist) or {}
    family = str(context.get("family") or "unsupported")
    projection = str(context.get("projection") or _axes_projection_name(artist))
    reason = context.get("degradedReason") or (
        "Special axes layout, projection, and cross-axis geometry are read-only until their replay contract is proven."
    )
    props = {
        "axesFamily": family,
        "projection": projection,
        "axesClass": type(artist).__name__,
        "layoutEditable": False,
        "projectionEditable": False,
        "specialAxesUnsupportedReason": reason,
    }
    if family == "3d":
        props.update({
            "cameraEditable": False,
            "azim": _plain_value(getattr(artist, "azim", None)),
            "elev": _plain_value(getattr(artist, "elev", None)),
            "roll": _plain_value(getattr(artist, "roll", None)),
        })
    if family == "unsupported":
        props["degradedReason"] = reason
    return props


def _build_subplot_layout_meta(raw_elements: list[tuple[str, str, Any]]) -> dict[str, dict[str, Any]]:
    subplot_items = []
    for gid, kind, ax in raw_elements:
        if kind != "subplot":
            continue
        bounds = _safe_axes_position_bounds(ax)
        if bounds is None:
            continue
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

    if axis_name == "x":
        get_limits = getattr(axis.axes, "get_xlim", None)
    elif axis_name == "y":
        get_limits = getattr(axis.axes, "get_ylim", None)
    else:
        get_limits = getattr(axis.axes, "get_zlim", None)
    try:
        limits = list(get_limits()) if callable(get_limits) else []
    except Exception:
        limits = []

    return {
        "limits": limits,
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
    spines = list(getattr(ax, "spines", {}).values())
    if not spines:
        return {
            "visible": False,
            "color": "#000000",
            "linewidth": 0.0,
        }
    sample = spines[0]
    return {
        "visible": all(spine.get_visible() for spine in spines),
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
    props = _read_patch_props(first)
    props["zorder"] = float(first.get_zorder())
    provenance = _intercepted_complex_artists.get(container, {})
    if provenance.get("family") == "hist":
        props.update(_read_histogram_structure(provenance))
    return props


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


def _contour_owned_collections(artist) -> list:
    """Return legacy collection artists owned by a contour set.

    Matplotlib 3.7 stores one PathCollection per level on the Axes. From 3.8
    onward the QuadContourSet itself occupies that legacy collection slot.
    Keeping both shapes here preserves the GIDs produced by each renderer
    version while the new semantic parent remains version-independent.
    """
    axes = getattr(artist, "axes", None)
    axes_collections = list(getattr(axes, "collections", []) or []) if axes is not None else []
    if artist in axes_collections:
        return [artist]
    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return list(getattr(artist, "collections", []) or [])
    except Exception:
        return []


def _first_contour_collection_value(artist, getter_name: str):
    for child in _contour_owned_collections(artist):
        getter = getattr(child, getter_name, None)
        if not callable(getter):
            continue
        try:
            value = getter()
        except Exception:
            continue
        if value is None:
            continue
        try:
            if len(value) > 0:
                return value[0]
        except TypeError:
            return value
    return None


def _normalize_contour_linestyle(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)) and value:
        first = value[0]
        if isinstance(first, str):
            return first
    return "solid"


def _read_contour_props(artist) -> dict:
    mappable_props = _read_heatmap_props(artist)
    provenance = _intercepted_complex_artists.get(artist, {})
    children = _contour_owned_collections(artist)
    props = {
        key: mappable_props.get(key)
        for key in ("cmap", "vmin", "vmax", "alpha")
    }
    try:
        levels = getattr(artist, "levels", None)
        props["levels"] = [float(value) for value in list(levels)] if levels is not None else []
    except Exception:
        props["levels"] = []
    props["filled"] = bool(getattr(artist, "filled", False))

    visible_getter = getattr(artist, "get_visible", None)
    if callable(visible_getter):
        try:
            props["visible"] = bool(visible_getter())
        except Exception:
            props["visible"] = True
    else:
        props["visible"] = all(
            bool(child.get_visible())
            for child in children
            if callable(getattr(child, "get_visible", None))
        )

    zorder_getter = getattr(artist, "get_zorder", None)
    zorder = None
    if callable(zorder_getter):
        try:
            zorder = float(zorder_getter())
        except Exception:
            zorder = None
    if zorder is None:
        child_zorder = _first_contour_collection_value(artist, "get_zorder")
        try:
            zorder = float(child_zorder) if child_zorder is not None else 1.0
        except Exception:
            zorder = 1.0
    props["zorder"] = zorder

    if not props["filled"]:
        linewidth = _first_contour_collection_value(artist, "get_linewidths")
        if linewidth is None:
            linewidth = _first_contour_collection_value(artist, "get_linewidth")
        try:
            props["linewidth"] = float(linewidth)
        except Exception:
            props["linewidth"] = 1.0
        props["linestyle"] = _normalize_contour_linestyle(
            provenance.get("linestyle")
            if provenance.get("linestyle") is not None
            else _first_contour_collection_value(artist, "get_linestyles")
        )
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
    "polar_subplot": _read_special_axes_props,
    "three_d_subplot": _read_special_axes_props,
    "inset_subplot": _read_special_axes_props,
    "geo_subplot": _read_special_axes_props,
    "parasite_subplot": _read_special_axes_props,
    "parasite_axis": _read_special_axes_props,
    "secondary_xaxis": _read_special_axes_props,
    "secondary_yaxis": _read_special_axes_props,
    "unsupported_axes": _read_special_axes_props,
    "brokenaxes_group": _read_special_axes_props,
    "spine": _read_spine_props,
    "spine_group": _read_spine_group_props,
    "legend": _read_legend_props,
    "line": _read_line_props,
    "collection": _read_collection_props,
    "quiver": _read_quiver_props,
    "fill_between": _read_fill_between_props,
    "streamplot": _read_streamplot_props,
    "contour": _read_contour_props,
    "contourf": _read_contour_props,
    "patch": _read_patch_props,
    "axes": _read_axes_props,
    "grid": _read_grid_props,
    "axis_x": lambda artist: _read_axis_props(artist, "x"),
    "axis_y": lambda artist: _read_axis_props(artist, "y"),
    "axis_z": lambda artist: _read_axis_props(artist, "z"),
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
# Radar semantics and editable fields
# ---------------------------------------------------------------------------

def _radar_closed_xy(x_values: Any, y_values: Any) -> bool:
    try:
        x = np.asarray(x_values, dtype=float).reshape(-1)
        y = np.asarray(y_values, dtype=float).reshape(-1)
    except Exception:
        return False
    if x.size < 4 or y.size != x.size:
        return False
    theta_closed = bool(np.isclose(np.mod(x[-1] - x[0], 2 * np.pi), 0.0, atol=1e-6))
    radius_closed = bool(np.isclose(y[-1], y[0], rtol=1e-6, atol=1e-8))
    return theta_closed and radius_closed


def _radar_xy_matches_dimensions(axes: Any, x_values: Any, y_values: Any) -> bool:
    if not _radar_closed_xy(x_values, y_values):
        return False
    try:
        x = np.asarray(x_values, dtype=float).reshape(-1)
        ticks = np.asarray(axes.get_xticks(), dtype=float).reshape(-1)
    except Exception:
        return False
    if ticks.size < 3 or x.size != ticks.size + 1:
        return False
    labels = list(getattr(axes, "get_xticklabels", lambda: [])())
    if sum(bool(str(getattr(label, "get_text", lambda: "")()).strip()) for label in labels) < 3:
        return False

    # Compare angles on the unit circle so an equivalent 0/2pi wrap or a
    # cyclic starting dimension remains valid, while dense polar traces do not.
    deltas = np.angle(np.exp(1j * (x[:-1, None] - ticks[None, :])))
    matches = np.abs(deltas) <= 1e-6
    return bool(np.all(matches.sum(axis=0) == 1) and np.all(matches.sum(axis=1) == 1))


def _radar_axes(axes: Any) -> bool:
    if axes is None or _axes_projection_name(axes) != "polar":
        return False
    dimension_labels = [
        label
        for label in getattr(axes, "get_xticklabels", lambda: [])()
        if str(getattr(label, "get_text", lambda: "")()).strip()
    ]
    if len(dimension_labels) < 3:
        return False
    for line in getattr(axes, "lines", []) or []:
        try:
            if _radar_xy_matches_dimensions(axes, line.get_xdata(orig=False), line.get_ydata(orig=False)):
                return True
        except Exception:
            continue
    try:
        from matplotlib.patches import Polygon
        for patch in getattr(axes, "patches", []) or []:
            if not isinstance(patch, Polygon):
                continue
            vertices = np.asarray(patch.get_xy(), dtype=float)
            if (
                vertices.ndim == 2
                and vertices.shape[1] >= 2
                and _radar_xy_matches_dimensions(axes, vertices[:, 0], vertices[:, 1])
            ):
                return True
    except Exception:
        pass
    return False


def _radar_series_index_for_line(axes: Any, artist: Any) -> Optional[int]:
    radar_lines = []
    for line in getattr(axes, "lines", []) or []:
        try:
            if _radar_xy_matches_dimensions(axes, line.get_xdata(orig=False), line.get_ydata(orig=False)):
                radar_lines.append(line)
        except Exception:
            continue
    try:
        return radar_lines.index(artist)
    except ValueError:
        return None


def _radar_line_style_signature(artist: Any) -> Optional[tuple]:
    try:
        color = tuple(round(float(channel), 8) for channel in mcolors.to_rgba(artist.get_color()))
        return (
            color,
            str(artist.get_linestyle()),
            str(artist.get_marker()),
            round(float(artist.get_linewidth()), 8),
        )
    except Exception:
        return None


def _radar_series_index_for_legend_entry(axes: Any, legend: Any, entry_index: int) -> Optional[int]:
    handles = _get_legend_handles(legend)
    if entry_index < 0 or entry_index >= len(handles):
        return None
    handle_signature = _radar_line_style_signature(handles[entry_index])
    if handle_signature is None:
        return None

    matching_lines = [
        line
        for line in getattr(axes, "lines", []) or []
        if _radar_line_style_signature(line) == handle_signature
    ]
    if len(matching_lines) != 1:
        return None
    return _radar_series_index_for_line(axes, matching_lines[0])


def _radar_matching_series_for_polygon(axes: Any, artist: Any) -> Optional[int]:
    try:
        vertices = np.asarray(artist.get_xy(), dtype=float)
    except Exception:
        return None
    if vertices.ndim != 2 or vertices.shape[1] < 2:
        return None
    radar_lines = []
    for line in getattr(axes, "lines", []) or []:
        try:
            x = np.asarray(line.get_xdata(orig=False), dtype=float).reshape(-1)
            y = np.asarray(line.get_ydata(orig=False), dtype=float).reshape(-1)
        except Exception:
            continue
        if _radar_xy_matches_dimensions(axes, x, y):
            radar_lines.append((line, x, y))
    for index, (_, x, y) in enumerate(radar_lines):
        if len(x) != len(vertices):
            continue
        if np.allclose(x, vertices[:, 0], rtol=1e-6, atol=1e-8) and np.allclose(y, vertices[:, 1], rtol=1e-6, atol=1e-8):
            return index
    return None


def _radar_metadata_for_artist(artist: Any) -> Optional[dict]:
    context = _axes_context_for_artist(artist) or {}
    axes = context.get("axes")
    if not _radar_axes(axes):
        return None
    axes_index = int(context.get("axesIndex", 0))
    metadata: dict[str, Any] = {"radarId": f"radar.{axes_index}"}

    x_tick_labels = list(getattr(axes, "get_xticklabels", lambda: [])())
    if artist in x_tick_labels:
        metadata.update({
            "radarSemanticRole": "dimension_label",
            "radarDimensionIndex": x_tick_labels.index(artist),
        })
        return metadata

    line_index = _radar_series_index_for_line(axes, artist)
    if line_index is not None:
        metadata.update({
            "radarSemanticRole": "series",
            "radarSeriesId": f"radar.{axes_index}.series.{line_index}",
        })
        return metadata

    try:
        from matplotlib.patches import Polygon
        if isinstance(artist, Polygon):
            vertices = np.asarray(artist.get_xy(), dtype=float)
            if (
                vertices.ndim != 2
                or vertices.shape[1] < 2
                or not _radar_xy_matches_dimensions(axes, vertices[:, 0], vertices[:, 1])
            ):
                return metadata
            series_index = _radar_matching_series_for_polygon(axes, artist)
            if series_index is None:
                radar_polygons = [
                    patch
                    for patch in getattr(axes, "patches", []) or []
                    if isinstance(patch, Polygon)
                    and _radar_xy_matches_dimensions(
                        axes,
                        np.asarray(patch.get_xy(), dtype=float)[:, 0],
                        np.asarray(patch.get_xy(), dtype=float)[:, 1],
                    )
                ]
                series_index = radar_polygons.index(artist) if artist in radar_polygons else 0
            metadata.update({
                "radarSemanticRole": "fill",
                "radarSeriesId": f"radar.{axes_index}.series.{series_index}",
            })
            return metadata
    except Exception:
        pass

    for _, legend in _iter_axes_legends(axes):
        if artist is legend:
            metadata["radarSemanticRole"] = "legend"
            return metadata
        legend_texts = list(legend.get_texts())
        if artist in legend_texts:
            legend_index = legend_texts.index(artist)
            series_index = _radar_series_index_for_legend_entry(axes, legend, legend_index)
            if series_index is None:
                return metadata
            metadata.update({
                "radarSemanticRole": "legend_text",
                "radarSeriesId": f"radar.{axes_index}.series.{series_index}",
            })
            return metadata
        if artist is legend.get_title():
            metadata["radarSemanticRole"] = "legend_title"
            return metadata
    return metadata


def _apply_radar_metadata_to_object(obj: dict, artist: Any) -> None:
    metadata = _radar_metadata_for_artist(artist)
    if not metadata:
        return
    obj.update(metadata)
    obj["currentProps"] = {**obj.get("currentProps", {}), **metadata}
    if metadata.get("radarSemanticRole") == "fill":
        series_id = metadata.get("radarSeriesId")
        axes = (_axes_context_for_artist(artist) or {}).get("axes")
        try:
            series_index = int(str(series_id).rsplit(".", 1)[-1])
            radar_lines = [
                line
                for line in getattr(axes, "lines", []) or []
                if _radar_series_index_for_line(axes, line) is not None
            ]
            series_label = radar_lines[series_index].get_label()
            if series_label and not str(series_label).startswith("_"):
                obj["label"] = f"{series_label} fill"
                obj["currentProps"]["radarSeriesLabel"] = str(series_label)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Editable fields per kind
# ---------------------------------------------------------------------------

_EDITABLE = {
    "text": [
        "text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color",
        "ha", "va", "rotation", "position", "zorder", "bbox_visible",
        "bbox_facecolor", "bbox_edgecolor", "bbox_alpha", "bbox_linewidth",
        "bbox_pad", "bbox_boxstyle",
    ],
    "subplot": ["left", "bottom", "width", "height", "aspect", "zorder"],
    "spine": ["visible", "color", "linewidth", "zorder"],
    "spine_group": ["visible", "color", "linewidth", "zorder"],
    "legend": ["visible", "fontsize", "frameon", "facecolor", "edgecolor", "linewidth", "alpha", "loc", "ncol", "markerscale", "marker_yoffset", "handletextpad", "labelspacing", "handlelength", "handleheight", "columnspacing", "borderpad", "borderaxespad", "title", "fontfamily", "fontweight", "fontstyle", "position", "zorder"],
    "line": ["color", "linewidth", "linestyle", "alpha", "marker", "markersize", "zorder"],
    "patch": ["facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
    "collection": ["facecolor", "edgecolor", "alpha", "linewidth", "size", "size_scale", "zorder"],
    "quiver": ["color", "facecolor", "edgecolor", "alpha", "linewidth", "visible", "zorder"],
    "fill_between": ["facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
    "contour": ["cmap", "vmin", "vmax", "alpha", "linewidth", "linestyle", "visible", "zorder"],
    "contourf": ["cmap", "vmin", "vmax", "alpha", "visible", "zorder"],
    "streamplot": ["color", "alpha", "linewidth", "visible", "zorder"],
    "axes": ["xlim", "ylim", "show_minor_ticks", "x_tick_rotation", "tick_direction", "zorder"],
    "grid": ["visible", "color", "linewidth", "linestyle", "alpha", "zorder"],
    "axis_x": ["limits", "label", "label_fontsize", "label_color", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad", "minor_tick_length", "minor_tick_width", "minor_tick_color", "show_minor_ticks", "tick_labelsize", "tick_labelcolor", "tick_labelfamily", "tick_fontweight", "tick_fontstyle", "tick_label_dx", "tick_label_dy", "sci_notation", "use_math_text", "offset_text_size"],
    "axis_y": ["limits", "label", "label_fontsize", "label_color", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad", "minor_tick_length", "minor_tick_width", "minor_tick_color", "show_minor_ticks", "tick_labelsize", "tick_labelcolor", "tick_labelfamily", "tick_fontweight", "tick_fontstyle", "tick_label_dx", "tick_label_dy", "sci_notation", "use_math_text", "offset_text_size"],
    "axis_z": ["limits", "label", "label_fontsize", "label_color", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad", "minor_tick_length", "minor_tick_width", "minor_tick_color", "show_minor_ticks", "tick_labelsize", "tick_labelcolor", "tick_labelfamily", "tick_fontweight", "tick_fontstyle", "tick_label_dx", "tick_label_dy", "sci_notation", "use_math_text", "offset_text_size"],
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


_SPECIAL_AXES_SAFE_AXIS_PROPS = {
    "label",
    "label_fontsize",
    "label_color",
    "tick_labelsize",
    "tick_labelcolor",
    "tick_labelfamily",
    "tick_fontweight",
    "tick_fontstyle",
}

_SPECIAL_AXES_FULLY_READONLY_FAMILIES = {
    "unsupported",
    "geo",
    "broken",
    "parasite",
    "parasite_host",
}


def _special_axes_edit_contract(kind: str, artist: Any, current_props: dict, editable: list[str]):
    context = _axes_context_for_artist(artist)
    if not context or context.get("family") in {None, "cartesian", "colorbar"}:
        return current_props, editable

    family = str(context.get("family"))
    projection = str(context.get("projection") or _axes_projection_name(context.get("axes")))
    reason = context.get("degradedReason") or (
        "Special axes geometry is protected; use source code for projection, bounds, limits, camera, or cross-axis layout changes."
    )
    current_props = {
        **current_props,
        "axesFamily": family,
        "projection": projection,
        "axesClass": type(context.get("axes")).__name__,
        "specialAxes": True,
        "specialAxesUnsupportedReason": reason,
    }

    if family in _SPECIAL_AXES_FULLY_READONLY_FAMILIES:
        current_props["editingUnsupportedReason"] = reason
        return current_props, []

    if kind in _DATA_PANEL_KINDS or kind in {
        "axes",
        "secondary_xaxis",
        "secondary_yaxis",
        "parasite_axis",
        "brokenaxes_group",
    }:
        return current_props, []
    if kind in {"axis_x", "axis_y", "axis_z"}:
        return current_props, [prop for prop in editable if prop in _SPECIAL_AXES_SAFE_AXIS_PROPS]
    if kind == "legend":
        if family == "polar" and _radar_axes(context.get("axes")):
            return current_props, editable
        return current_props, [prop for prop in editable if prop != "position"]
    if kind == "text":
        protected = [prop for prop in editable if prop != "position"]
        radar_metadata = _radar_metadata_for_artist(artist)
        if radar_metadata and radar_metadata.get("radarSemanticRole") == "dimension_label":
            current_props = {
                **current_props,
                **radar_metadata,
                "radar_label_offset": {
                    "dx": float(getattr(artist, "_scifigure_radar_label_dx", 0.0) or 0.0),
                    "dy": float(getattr(artist, "_scifigure_radar_label_dy", 0.0) or 0.0),
                },
            }
            protected.append("radar_label_offset")
        return current_props, list(dict.fromkeys(protected))
    return current_props, editable


def _apply_axes_relation_metadata(obj: dict, artist: Any) -> None:
    context = _axes_context_for_artist(artist)
    if not context:
        return
    scope_subplot_id = context.get("scopeSubplotId")
    if scope_subplot_id and not _is_figure_level_object(obj):
        obj["subplotId"] = scope_subplot_id

    family = context.get("family")
    if family in {None, "cartesian", "colorbar"}:
        return
    obj["axesFamily"] = str(family)
    obj["projection"] = str(context.get("projection") or "")
    owner_subplot_id = context.get("panelGid")
    parent_subplot_id = context.get("parentPanelGid") or owner_subplot_id
    if parent_subplot_id:
        obj["parentSubplotId"] = parent_subplot_id
    if owner_subplot_id:
        obj["ownerSubplotId"] = owner_subplot_id
    if context.get("parentPanelGid") and obj.get("id") == owner_subplot_id:
        obj["parentId"] = context["parentPanelGid"]


def _determine_role(
    gid: str,
    parent_kind: Optional[str] = None,
    kind: Optional[str] = None,
    artist: Any = None,
) -> Optional[str]:
    provenance = _intercepted_complex_artists.get(artist, {})
    semantic_role = provenance.get("semanticRole")
    if semantic_role:
        return semantic_role
    family = provenance.get("family")
    if family == "hist":
        return "histogram_series"
    if family == "stairs":
        return "stairs_series"
    if family == "step":
        return "step_series"
    if family == "quiver":
        return "quiver_field"
    if family == "streamplot" and kind == "streamplot":
        return "streamplot_field"
    special_panel_roles = {
        "polar_subplot": "polar_subplot_panel",
        "three_d_subplot": "three_d_subplot_panel",
        "inset_subplot": "inset_subplot_panel",
        "geo_subplot": "geo_subplot_panel",
        "parasite_subplot": "parasite_host_panel",
        "parasite_axis": "parasite_axis",
        "secondary_xaxis": "secondary_x_axis",
        "secondary_yaxis": "secondary_y_axis",
        "unsupported_axes": "unsupported_projection_panel",
        "brokenaxes_group": "brokenaxes_panel_group",
    }
    if kind in special_panel_roles:
        return special_panel_roles[kind]
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
    if gid.startswith("zlabel."):
        return "z_axis_label"
    if gid.startswith("xtick."):
        return "x_tick_label"
    if gid.startswith("ytick."):
        return "y_tick_label"
    if gid.startswith("ztick."):
        return "z_tick_label"
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
    if parent_kind in {"contour", "contourf"}:
        return "contour_child_collection"
    if parent_kind == "histogram":
        return "histogram_child_patch"

    if kind == "fill_between":
        return "fill_between_series"
    if kind == "contour":
        return "contour_series"
    if kind == "contourf":
        return "contourf_series"
    if kind == "patch":
        try:
            from matplotlib.patches import Wedge
            if isinstance(artist, Wedge):
                return "wedge_slice"
        except Exception:
            pass
        
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


def _collection_structural_fingerprint_parts(artist: Any) -> list[str]:
    if not hasattr(artist, "get_offsets"):
        return []
    try:
        offsets = artist.get_offsets()
        if offsets is None:
            return []
        arr = np.ma.asarray(offsets)
        if arr.size == 0:
            return ["offsets.empty"]
        filled = np.ma.filled(arr.astype(float), np.nan)
        flat = filled.reshape(-1)
        finite = flat[np.isfinite(flat)]
        parts = [f"offsets_shape.{tuple(filled.shape)}"]
        if finite.size:
            parts.append(f"offsets_mean.{float(finite.mean()):.6f}")
            parts.append(f"offsets_min.{float(finite.min()):.6f}")
            parts.append(f"offsets_max.{float(finite.max()):.6f}")
            preview = ",".join(f"{float(value):.6f}" for value in finite[:8])
            parts.append(f"offsets_preview.{preview}")
        else:
            parts.append("offsets_all_nan")
        return parts
    except Exception:
        return []


def _legacy_weak_collection_fingerprint(stable_key: str, artist: Any) -> str:
    fp_str = "|".join([stable_key, type(artist).__name__])
    return hashlib.sha256(fp_str.encode("utf-8")).hexdigest()


def _collection_sibling_count(artist: Any) -> int:
    axes = getattr(artist, "axes", None)
    collections = list(getattr(axes, "collections", []) or []) if axes is not None else []
    return len(collections)


def _generate_stable_key_and_fingerprint(obj: dict, artist: Any, ax_idx: int) -> tuple[str, str]:
    kind = obj["kind"]
    gid = obj["id"]
    label = obj.get("label") or ""
    
    clean_label = ""
    if label and not label.startswith("_") and not label.startswith("line.") and not label.startswith("patch.") and not label.startswith("collection."):
        clean_label = label
    if (
        _intercepted_complex_artists.get(artist, {}).get("family") == "hist"
        and isinstance(artist, matplotlib.container.BarContainer)
    ):
        # Axes.hist historically exposed private BarContainer labels, so old
        # stable keys used the container index. Keep that identity even though
        # the manifest now exposes the user-facing legend label.
        clean_label = ""
        
    # Dedicated semantics were introduced after these historical GIDs and
    # stable keys were already persisted in user projects. Keep their original
    # structural identity namespaces so existing edit logs remain replayable.
    identity_kind = "collection" if kind in {"fill_between", "quiver"} else kind
    parts = [f"ax{ax_idx}", identity_kind]
    if clean_label:
        parts.append(f"label.{clean_label}")
    else:
        match = re.search(r'\.(\d+)$', gid)
        if match:
            parts.append(f"idx.{match.group(1)}")
            
    stable_key = ".".join(parts)
    
    fp_parts = [stable_key]
    is_legend_proxy = obj.get("role") == "legend_marker" or gid.startswith(("legend_", "legend."))
    collection_parts = [] if is_legend_proxy else _collection_structural_fingerprint_parts(artist)
    if collection_parts:
        fp_parts.extend(collection_parts)
    elif not is_legend_proxy and hasattr(artist, "get_xydata"):
        try:
            xy = artist.get_xydata()
            if xy is not None and xy.size > 0:
                fp_parts.append(f"data_shape.{xy.shape}")
                fp_parts.append(f"data_mean.{xy.mean():.4f}")
        except Exception:
            pass
            
    fp_parts.append(type(artist).__name__)
            
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
    "line", "collection", "quiver", "streamplot", "fill_between", "contour", "contourf", "patch",
    "bar_container", "errorbar_container", "stem_container", "boxplot_container", "violinplot_container", "heatmap"
}

_AXIS_TICK_TYPOGRAPHY_GROUP_PROPS = {
    "tick_labelsize",
    "tick_labelcolor",
    "tick_labelfamily",
    "tick_fontweight",
    "tick_fontstyle",
    "tick_rotation",
}


_DEDICATED_COMPLEX_KIND_FAMILIES = {
    "contour": "contour",
    "contourf": "contourf",
    "fill_between": "fill_between",
    "histogram": "hist",
    "pie": "pie",
    "quiver": "quiver",
    "streamplot": "streamplot",
    "stairs": "stairs",
    "step": "step",
    "wedge": "wedge",
}

_DEDICATED_COMPLEX_ROLE_FAMILIES = {
    "contour_series": "contour",
    "contourf_series": "contourf",
    "fill_between_series": "fill_between",
    "histogram_series": "hist",
    "pie_slice": "pie",
    "quiver_field": "quiver",
    "streamplot_field": "streamplot",
    "stairs_series": "stairs",
    "step_series": "step",
    "wedge_slice": "wedge",
    "diagram_node": "diagram",
    "diagram_edge": "diagram",
    "diagram_arrow": "diagram",
    "diagram_node_label": "diagram",
    "diagram_coefficient_label": "diagram",
    "diagram_fit_annotation": "diagram",
    "diagram_group": "diagram",
}


def _dedicated_complex_family(obj: dict) -> Optional[str]:
    return (
        _DEDICATED_COMPLEX_KIND_FAMILIES.get(obj.get("kind"))
        or _DEDICATED_COMPLEX_ROLE_FAMILIES.get(obj.get("role"))
    )


def _contour_family(artist: Any) -> str:
    filled = getattr(artist, "filled", None)
    if isinstance(filled, bool):
        return "contourf" if filled else "contour"
    return "contour_family"


def _build_complex_artist_context(raw_elements: list[tuple[str, str, Any]], annotation_links: dict) -> dict:
    # Dedicated provenance is authoritative. Class co-occurrence alone cannot
    # distinguish streamplot output from unrelated line collections/arrows.
    return {}


def _semantic_coverage_entry(obj: dict, artist: Any, context: Optional[dict] = None) -> Optional[dict]:
    """Shadow-only semantic coverage; never changes editability or replay."""
    context = context or {}
    cls_name = type(artist).__name__
    gid = obj.get("id", "")
    kind = obj.get("kind")
    role = obj.get("role")

    # Exclude support/decorative contexts that happen to reuse data artist
    # classes; these are already represented by their owning semantic object.
    if role in {
        "legend_marker",
        "annotation_arrow",
        "contour_child_collection",
        "streamplot_child_line",
        "streamplot_child_arrow",
    }:
        return None
    if gid.startswith((
        "legend_line.", "legend_patch.", "legend_collection.",
        "spine.", "grid.", "xtick.", "ytick.",
    )):
        return None
    if obj.get("_colorbarChild"):
        return None

    dedicated_family = _dedicated_complex_family(obj)
    provenance = _intercepted_complex_artists.get(artist, {})
    status = "ambiguous"
    family = None
    reason = ""
    attribution = "source.artistClass"

    if dedicated_family:
        status = "dedicated"
        family = dedicated_family
        if provenance.get("family") == dedicated_family:
            attribution = "source.call"
            reason = f"Dedicated semantics derived from intercepted {provenance.get('callName', dedicated_family)}."
        else:
            reason = "Object already has a dedicated semantic kind or role."
    elif cls_name == "FillBetweenPolyCollection":
        status = "flattened"
        family = "fill_between"
        reason = "fill_between is exposed as a generic collection; existing collection controls are preserved."
    elif cls_name == "Quiver":
        status = "flattened"
        family = "quiver"
        reason = "quiver is exposed as a generic collection; existing collection controls are preserved."
    elif cls_name == "StepPatch":
        status = "flattened"
        family = "stairs"
        reason = "stairs is exposed as a generic patch; existing patch controls are preserved."
    elif cls_name == "Wedge":
        status = "flattened"
        family = "wedge"
        reason = "wedge is exposed as a generic patch; existing patch controls are preserved."
    elif cls_name in {"QuadContourSet", "ContourSet"}:
        status = "flattened"
        family = _contour_family(artist)
        reason = "contour output is exposed without a dedicated contour manifest object."
    else:
        return None

    entry = {
        "family": family,
        "status": status,
        "attribution": attribution,
        "preservedKind": kind,
        "preservedEditable": list(obj.get("editable") or []),
        "reason": reason,
    }
    if role:
        entry["preservedRole"] = role
    return entry


def _legend_container_gid(gid: str) -> Optional[str]:
    figure_match = re.match(
        r"^legend_(?:title|text|line|patch|collection)\.figure\.(\d+)", gid
    )
    if figure_match:
        return f"legend.figure.{figure_match.group(1)}"
    extra_axes_match = re.match(
        r"^legend_(?:title|text|line|patch|collection)\.(\d+)\.extra\.(\d+)",
        gid,
    )
    if extra_axes_match:
        return f"legend.{extra_axes_match.group(1)}.extra.{extra_axes_match.group(2)}"
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
    if kind in _DATA_PANEL_KINDS or kind in {
        "colorbar",
        "secondary_xaxis",
        "secondary_yaxis",
        "parasite_axis",
        "brokenaxes_group",
    }:
        return "figure"
    if kind in {"line", "collection", "quiver", "streamplot", "fill_between", "contour", "contourf", "patch", "heatmap"}:
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
    for relation_name in ("axesFamily", "projection", "parentSubplotId", "ownerSubplotId"):
        if obj.get(relation_name) is not None:
            relation[relation_name] = obj[relation_name]
    for relation_name in ("radarId", "radarSemanticRole", "radarSeriesId"):
        if obj.get(relation_name) is not None:
            relation[relation_name] = obj[relation_name]
    if obj.get("radarDimensionIndex") is not None:
        relation["radarDimensionIndex"] = int(obj["radarDimensionIndex"])
    for relation_name in ("pieId", "pieSliceId", "pieLabelId", "pieValueLabelId"):
        if obj.get(relation_name) is not None:
            relation[relation_name] = obj[relation_name]
    if obj.get("sliceIndex") is not None:
        relation["sliceIndex"] = int(obj["sliceIndex"])
    for relation_name in ("quiverId", "streamplotId", "lineCollectionId"):
        if obj.get(relation_name) is not None:
            relation[relation_name] = obj[relation_name]
    if obj.get("arrowPatchIds"):
        relation["arrowPatchIds"] = list(obj["arrowPatchIds"])
    for relation_name in _DIAGRAM_RELATION_FIELDS:
        if obj.get(relation_name) is not None:
            relation[relation_name] = obj[relation_name]

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
    diagram_id = relation.get("diagramId")
    diagram_object_id = relation.get("diagramObjectId")
    if diagram_id and diagram_object_id:
        semantic_suffix = f"{diagram_id}:{role}:{diagram_object_id}"

    identity = {
        "semanticKey": f"{role}:{semantic_suffix}",
        "instanceKey": f"{scope}:{gid}",
        "scope": scope,
        "coordinateSpace": _identity_coordinate_space(obj),
    }
    if kind in _SERIES_KINDS and role != "annotation_arrow":
        identity["seriesKey"] = obj.get("stableKey") or f"{kind}:{gid}"
    if diagram_id and diagram_object_id:
        identity["seriesKey"] = f"diagram:{diagram_id}:{role}:{diagram_object_id}"
    if relation:
        identity["relation"] = relation
    return identity


def _property_derived_effects(prop: str) -> list[str]:
    if prop in {
        "text", "fontsize", "fontfamily", "fontweight", "fontstyle", "rotation",
        "bbox_visible", "bbox_facecolor", "bbox_edgecolor", "bbox_alpha",
        "bbox_linewidth", "bbox_pad", "bbox_boxstyle",
    }:
        return ["text_bounds"]
    if prop in {"position", "radar_label_offset"}:
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
        requires_backend_patch = (
            obj.get("kind") in _PARENT_OBJECT_KINDS
            or obj.get("kind") in {"quiver"}
            or str(obj.get("role", "")).startswith("diagram_")
            or (obj.get("kind") == "grid" and prop == "visible")
            or (obj.get("kind") == "heatmap" and prop == "alpha")
        )
        scopes = ["object"]
        if obj.get("role") and prop not in {"position", "anchor_position", "radar_label_offset"}:
            scopes.append("group")
        if obj.get("kind") in {"axis_x", "axis_y"} and prop in _AXIS_TICK_TYPOGRAPHY_GROUP_PROPS:
            scopes.append("group")
        if relation.get("subplotId"):
            scopes.append("subplot")
        if prop not in {"position", "radar_label_offset", "left", "bottom", "width", "height"}:
            scopes.append("figure")
        if prop != "radar_label_offset" and prop not in _CROSS_FIGURE_UNSAFE_PROPS:
            scopes.append("cross_figure")

        preview = "exact" if prop in _LOCAL_PREVIEW_PROPS and not requires_backend_patch else "none"
        replay = "stable"
        capability = {
            "prop": prop,
            "patchMode": (
                "backend_patch" if requires_backend_patch
                else "local_patch" if prop in _LOCAL_PREVIEW_PROPS
                else "backend_patch"
            ),
            "scopes": list(dict.fromkeys(scopes)),
            "preview": preview,
            "replay": replay,
        }
        if prop in {"position", "anchor_position", "radar_label_offset"}:
            capability["preview"] = "approximate"
            capability["replay"] = "stable" if prop == "radar_label_offset" else "conditional"
            capability["coordinateSpace"] = (
                obj.get("currentProps", {}).get("anchor_coord_system", "none")
                if prop == "anchor_position"
                else "display"
                if prop == "radar_label_offset"
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


_PARENT_OBJECT_KINDS = {
    "bar_container",
    "errorbar_container",
    "boxplot_container",
    "violinplot_container",
    "stem_container",
    "container",
    "contour",
    "contourf",
    "streamplot",
}


def _parent_relation_kind(kind: str, artist: Any) -> str:
    if (
        kind == "bar_container"
        and _intercepted_complex_artists.get(artist, {}).get("family") == "hist"
    ):
        return "histogram"
    return kind


def _parent_child_gids(kind: str, artist: Any, raw_elements, artist_to_gid) -> list[str]:
    if kind == "bar_container":
        return [artist_to_gid[child] for child in artist if child in artist_to_gid]
    if kind in {"errorbar_container", "stem_container", "boxplot_container", "violinplot_container"}:
        return [
            artist_to_gid[child]
            for child in artist.get_children()
            if child in artist_to_gid
        ]
    if kind in {"contour", "contourf"}:
        owned = set(_contour_owned_collections(artist))
        return [
            child_gid
            for child_gid, child_kind, child in raw_elements
            if child_kind == "collection" and child in owned
        ]
    if kind == "streamplot":
        return [
            artist_to_gid[child]
            for child in artist.get_children()
            if child in artist_to_gid
        ]
    return []


# ---------------------------------------------------------------------------
# Kind from gid prefix
# ---------------------------------------------------------------------------

# (removed: kind is now yielded directly by iter_artists, not inferred from gid)


# ---------------------------------------------------------------------------
# Introspection entry point
# ---------------------------------------------------------------------------

_SVG_POINTS_PER_INCH = 72.0
_SVG_CANVAS_PADDING_INCHES = 0.08
_SVG_CANVAS_MAX_EXPANSION_FACTOR = 4.0


def _artist_bbox_in_inches(artist: Any, fig: Any, renderer: Any) -> Optional[Bbox]:
    """Return a visible artist's rendered bounds without honoring ``in_layout``."""
    try:
        if hasattr(artist, "get_visible") and not artist.get_visible():
            return None

        bbox = None
        get_tightbbox = getattr(artist, "get_tightbbox", None)
        if callable(get_tightbbox):
            bbox = get_tightbbox(renderer)
        if bbox is None:
            get_window_extent = getattr(artist, "get_window_extent", None)
            if callable(get_window_extent):
                bbox = get_window_extent(renderer)
        if bbox is None:
            return None

        extents = np.asarray(bbox.extents, dtype=float)
        if extents.shape != (4,) or not np.isfinite(extents).all():
            return None
        if abs(extents[2] - extents[0]) < 1e-12 and abs(extents[3] - extents[1]) < 1e-12:
            return None
        return Bbox.from_extents(*extents).transformed(fig.dpi_scale_trans.inverted())
    except (AttributeError, RuntimeError, TypeError, ValueError):
        return None


def _collect_rendered_artist_bounds(fig: Any, renderer: Any) -> Optional[Bbox]:
    """Collect visible rendered bounds, including artists excluded from layout."""
    try:
        candidates: list[Bbox] = []
        for artist in fig.findobj():
            if artist is fig:
                continue
            bbox = _artist_bbox_in_inches(artist, fig, renderer)
            if bbox is not None:
                candidates.append(bbox)
        if not candidates:
            return None
        left = min(bbox.x0 for bbox in candidates)
        bottom = min(bbox.y0 for bbox in candidates)
        right = max(bbox.x1 for bbox in candidates)
        top = max(bbox.y1 for bbox in candidates)
        return Bbox.from_extents(left, bottom, right, top)
    except (AttributeError, RuntimeError, TypeError, ValueError):
        return None


def _expanded_svg_canvas(fig) -> tuple[Optional[Bbox], dict[str, Any]]:
    """Expand overflowing edges while preserving the original Figure canvas."""
    width_in = float(fig.get_figwidth())
    height_in = float(fig.get_figheight())
    left_in = 0.0
    bottom_in = 0.0
    right_in = width_in
    top_in = height_in

    try:
        canvas = fig.canvas
        canvas.draw()
        renderer = getattr(canvas, "renderer", None) or canvas.get_renderer()
        tight_bbox = fig.get_tightbbox(renderer)
        if tight_bbox is not None:
            tight_extents = np.asarray(tight_bbox.extents, dtype=float)
            if tight_extents.shape == (4,) and np.isfinite(tight_extents).all():
                tight_left, tight_bottom, tight_right, tight_top = tight_extents.tolist()
                left_in = min(left_in, tight_left)
                bottom_in = min(bottom_in, tight_bottom)
                right_in = max(right_in, tight_right)
                top_in = max(top_in, tight_top)

        # ``Figure.get_tightbbox`` intentionally omits artists with
        # ``in_layout=False``. Those artists are still emitted by SVG and are
        # commonly used for legends/annotations positioned outside a subplot.
        rendered_bbox = _collect_rendered_artist_bounds(fig, renderer)
        if rendered_bbox is not None:
            left_in = min(left_in, rendered_bbox.x0)
            bottom_in = min(bottom_in, rendered_bbox.y0)
            right_in = max(right_in, rendered_bbox.x1)
            top_in = max(top_in, rendered_bbox.y1)

        max_horizontal_extension = max(width_in * _SVG_CANVAS_MAX_EXPANSION_FACTOR, 4.0)
        max_vertical_extension = max(height_in * _SVG_CANVAS_MAX_EXPANSION_FACTOR, 4.0)
        left_in = max(
            left_in - (_SVG_CANVAS_PADDING_INCHES if left_in < 0 else 0),
            -max_horizontal_extension,
        )
        bottom_in = max(
            bottom_in - (_SVG_CANVAS_PADDING_INCHES if bottom_in < 0 else 0),
            -max_vertical_extension,
        )
        right_in = min(
            right_in + (_SVG_CANVAS_PADDING_INCHES if right_in > width_in else 0),
            width_in + max_horizontal_extension,
        )
        top_in = min(
            top_in + (_SVG_CANVAS_PADDING_INCHES if top_in > height_in else 0),
            height_in + max_vertical_extension,
        )
    except Exception:
        left_in = 0.0
        bottom_in = 0.0
        right_in = width_in
        top_in = height_in

    expanded = any(abs(value) > 1e-9 for value in (
        left_in,
        bottom_in,
        right_in - width_in,
        top_in - height_in,
    ))
    save_bbox = Bbox.from_extents(left_in, bottom_in, right_in, top_in) if expanded else None

    def points(value: float) -> float:
        return round(float(value) * _SVG_POINTS_PER_INCH, 6)

    viewport = {
        "version": 1,
        "expanded": expanded,
        "canvas": {
            "x": 0.0,
            "y": 0.0,
            "width": points(right_in - left_in),
            "height": points(top_in - bottom_in),
        },
        "figure": {
            "x": points(-left_in),
            "y": points(top_in - height_in),
            "width": points(width_in),
            "height": points(height_in),
        },
    }
    return save_bbox, viewport

def introspect_figure(fig, semantic_manifest=None) -> dict:
    """Accept a fully rendered Figure, return {svg, manifest}."""

    introspection_started = time.perf_counter()

    # 1. Bind gids and build initial artist-to-gid mapping
    artist_to_gid = {}
    raw_elements = []
    
    for gid, kind, artist in iter_artists(fig):
        if artist is None:
            continue
        _register_explicit_diagram_artist(artist)
        if hasattr(artist, 'set_gid'):
            artist.set_gid(gid)
        artist_to_gid[artist] = gid
        raw_elements.append((gid, kind, artist))

    _normalise_runtime_fonts(raw_elements)
    _bind_raw_element_axes_contexts(raw_elements)

    # Matplotlib 3.8 also exposes QuadContourSet through ax.collections. The
    # semantic parent must remain the authoritative mappable for colorbars,
    # while the collection GID remains available only for legacy replay.
    for gid, kind, artist in raw_elements:
        if kind in {"contour", "contourf"}:
            artist_to_gid[artist] = gid

    subplot_meta = _build_subplot_layout_meta(raw_elements)

    # Colorbar Axes have their own figure index, which is not the subplot that
    # owns the data. Resolve ownership from Colorbar.mappable and preserve the
    # old gid/source axes index only as compatibility metadata.
    axes_to_subplot_gid = {
        artist: gid
        for gid, kind, artist in raw_elements
        if kind in _DATA_PANEL_KINDS
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
        try:
            shared_x_axes = axes.get_shared_x_axes().get_siblings(axes)
        except Exception:
            shared_x_axes = []
        try:
            shared_y_axes = axes.get_shared_y_axes().get_siblings(axes)
        except Exception:
            shared_y_axes = []
        subplot_relationships[subplot_gid] = {
            "twinSubplotIds": related_subplot_ids(twin_axes),
            "sharedXSubplotIds": related_subplot_ids(shared_x_axes),
            "sharedYSubplotIds": related_subplot_ids(shared_y_axes),
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
            if candidate is mappable or candidate_gid == mappable_gid or candidate_kind not in {"heatmap", "collection", "contour", "contourf"}:
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
    for gid, relationships in _build_label_matched_series_legend_relationships(
        raw_elements,
        artist_to_gid,
        {"errorbar_container"},
    ).items():
        legend_relationships.setdefault(gid, {}).update(relationships)

    pie_relationships = _build_pie_legend_relationships(raw_elements, artist_to_gid)

    for gid, relationships in _build_histogram_legend_relationships(
        raw_elements,
        artist_to_gid,
    ).items():
        legend_relationships.setdefault(gid, {}).update(relationships)
    for gid, relationships in _build_vector_field_legend_relationships(
        raw_elements,
        artist_to_gid,
    ).items():
        legend_relationships.setdefault(gid, {}).update(relationships)

    complex_artist_context = _build_complex_artist_context(raw_elements, annotation_links)

    # Build objects manifest list
    objects = []
    for gid, kind, artist in raw_elements:
        if kind == "grid_line":
            continue
        current_props = _read_props(artist, kind)
        label = _safe_artist_label(artist, gid)
        provenance = _intercepted_complex_artists.get(artist, {})
        if provenance.get("family") == "hist" and provenance.get("legendLabel"):
            label = str(provenance["legendLabel"])
        if provenance.get("semanticRole") in {"pie_label", "pie_value_label"}:
            label = str(getattr(artist, "get_text", lambda: label)())
        if provenance.get("semanticRole") in _DIAGRAM_PROTECTED_TEXT_ROLES:
            label = str(getattr(artist, "get_text", lambda: label)())
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
        current_props, editable = _special_axes_edit_contract(kind, artist, current_props, editable)
        diagram_role = provenance.get("semanticRole") if provenance.get("family") == "diagram" else None
        if diagram_role in _DIAGRAM_PROTECTED_TEXT_ROLES:
            editable = [prop for prop in editable if prop != "text"]
        if diagram_role:
            unsupported_props = sorted(_DIAGRAM_STRUCTURAL_PROPS_BY_ROLE.get(diagram_role, set()))
            current_props = {
                **current_props,
                "diagramSemanticRole": diagram_role,
                "unsupportedProps": unsupported_props,
            }
            if diagram_role in _DIAGRAM_PROTECTED_TEXT_ROLES:
                current_props["textContentReadonly"] = True
                current_props["textContentUnsupportedReason"] = (
                    "Scientific diagram labels preserve model meaning; edit typography or position, not content."
                )
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
        if kind in _PARENT_OBJECT_KINDS:
            children_gids = _parent_child_gids(kind, artist, raw_elements, artist_to_gid)
            relation_kind = _parent_relation_kind(kind, artist)
            
            # Update container object in objects list
            container_obj = next((o for o in objects if o["id"] == gid), None)
            if container_obj:
                container_obj["children"] = children_gids
            
            for child_gid in children_gids:
                child_to_parent[child_gid] = (gid, relation_kind)

                if relation_kind in {"contour", "contourf", "histogram", "streamplot"}:
                    child_obj = next((o for o in objects if o["id"] == child_gid), None)
                    if child_obj:
                        child_obj["editable"] = []
                        family_label = (
                            "Histogram bin patches" if relation_kind == "histogram"
                            else "Streamplot line and arrow children" if relation_kind == "streamplot"
                            else "Contour level collections"
                        )
                        child_obj["currentProps"] = {
                            **child_obj.get("currentProps", {}),
                            "parentOwned": True,
                            "editingUnsupportedReason": f"{family_label} are owned by the semantic parent; edit the parent object instead.",
                        }

    # Populate parentId, role, source, stableKey, and fingerprint for each object
    for obj in objects:
        gid = obj["id"]
        kind = obj["kind"]
        artist_obj = next(art for g, k, art in raw_elements if g == gid)
        
        # Link parent ID
        parent_info = child_to_parent.get(gid)
        parent_id = None
        parent_kind = None
        if parent_info:
            parent_id, parent_kind = parent_info
            obj["parentId"] = parent_id
            
        # Determine semantic role
        role = _determine_role(gid, parent_kind, kind, artist_obj)
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
        _apply_diagram_metadata_to_object(obj, artist_obj)
        _apply_radar_metadata_to_object(obj, artist_obj)

        complex_provenance = _intercepted_complex_artists.get(artist_obj, {})
        if complex_provenance.get("family") == "quiver" and complex_provenance.get("quiverId"):
            obj["quiverId"] = complex_provenance["quiverId"]
        if complex_provenance.get("family") == "streamplot" and complex_provenance.get("streamplotId"):
            obj["streamplotId"] = complex_provenance["streamplotId"]
            if kind == "streamplot":
                line_collection_id = artist_to_gid.get(complex_provenance.get("lineArtist"))
                arrow_patch_ids = [
                    artist_to_gid[arrow]
                    for arrow in complex_provenance.get("arrowArtists", [])
                    if arrow in artist_to_gid
                ]
                if line_collection_id:
                    obj["lineCollectionId"] = line_collection_id
                if arrow_patch_ids:
                    obj["arrowPatchIds"] = arrow_patch_ids

        for relation_name, relation_value in legend_relationships.get(gid, {}).items():
            if relation_value:
                obj[relation_name] = relation_value
        for relation_name, relation_value in pie_relationships.get(gid, {}).items():
            if relation_value is not None:
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

        object_axes_context = _axes_context_for_artist(artist_obj)
        if object_axes_context and isinstance(object_axes_context.get("axesIndex"), int):
            ax_idx = object_axes_context["axesIndex"]

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

        _apply_axes_relation_metadata(obj, artist_obj)

        axes_context = _axes_context_for_artist(artist_obj) or {}
        relationship_panel_id = axes_context.get("scopeSubplotId") or f"subplot.{ax_idx}"
        if kind in _DATA_PANEL_KINDS or kind in {"axes", "axis_x", "axis_y", "axis_z"}:
            for relation_name, related_ids in subplot_relationships.get(relationship_panel_id, {}).items():
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
        provenance = _intercepted_complex_artists.get(artist_obj, {})
        if provenance.get("callName"):
            source_meta["callName"] = provenance["callName"]
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
        semantic_coverage = _semantic_coverage_entry(obj, artist_obj, complex_artist_context)
        if semantic_coverage:
            obj["semanticCoverage"] = semantic_coverage
        
        # Add stableKey and fingerprint
        stable_key, fingerprint = _generate_stable_key_and_fingerprint(obj, artist_obj, ax_idx)
        obj["stableKey"] = stable_key
        obj["fingerprint"] = fingerprint
        obj["fingerprintVersion"] = 2
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
        obj.pop("axesFamily", None)
        obj.pop("projection", None)
        obj.pop("parentSubplotId", None)
        obj.pop("ownerSubplotId", None)
        obj.pop("pieId", None)
        obj.pop("pieSliceId", None)
        obj.pop("pieLabelId", None)
        obj.pop("pieValueLabelId", None)
        obj.pop("sliceIndex", None)
        obj.pop("quiverId", None)
        obj.pop("streamplotId", None)
        obj.pop("lineCollectionId", None)
        obj.pop("arrowPatchIds", None)
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
        if obj.get("role") in {
            "contour_child_collection",
            "histogram_child_patch",
            "streamplot_child_line",
            "streamplot_child_arrow",
        }:
            continue
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
    svg_canvas_bbox, render_viewport = _expanded_svg_canvas(fig)
    svg_serialize_started = time.perf_counter()
    fig.savefig(
        buf,
        format="svg",
        metadata={"Date": None},
        bbox_inches=svg_canvas_bbox,
        pad_inches=0,
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
    dedicated_count = 0
    flattened_count = 0
    ambiguous_count = 0
    by_kind = {}
    by_kind_meta = {}
    complex_artists = []
    
    for obj in objects:
        recognized_count += 1
        kind = obj["kind"]
        editable_props = obj["editable"]
        if editable_props:
            editable_count += 1
        else:
            readonly_count += 1

        prop_set = set(str(prop) for prop in editable_props)
        if kind not in by_kind:
            by_kind[kind] = {"count": 0, "editableProps": []}
            by_kind_meta[kind] = {
                "union": set(),
                "intersection": None,
                "variants": {},
            }
        by_kind[kind]["count"] += 1
        kind_meta = by_kind_meta[kind]
        kind_meta["union"].update(prop_set)
        if kind_meta["intersection"] is None:
            kind_meta["intersection"] = set(prop_set)
        else:
            kind_meta["intersection"].intersection_update(prop_set)
        variant_key = tuple(sorted(prop_set))
        kind_meta["variants"][variant_key] = kind_meta["variants"].get(variant_key, 0) + 1

        semantic_coverage = obj.get("semanticCoverage")
        if semantic_coverage:
            status = semantic_coverage.get("status")
            if status == "dedicated":
                dedicated_count += 1
            elif status == "flattened":
                flattened_count += 1
            elif status == "ambiguous":
                ambiguous_count += 1
            complex_row = {
                "id": obj.get("id"),
                "class": obj.get("source", {}).get("artistClass"),
                "family": semantic_coverage.get("family"),
                "status": status,
                "attribution": semantic_coverage.get("attribution"),
                "preservedKind": semantic_coverage.get("preservedKind"),
                "preservedRole": semantic_coverage.get("preservedRole"),
                "preservedEditable": list(semantic_coverage.get("preservedEditable") or []),
                "reason": semantic_coverage.get("reason"),
            }
            source_call = obj.get("source", {}).get("callName")
            if isinstance(source_call, str) and source_call:
                complex_row["sourceCall"] = source_call
            complex_artists.append(complex_row)

    for kind, detail in by_kind.items():
        kind_meta = by_kind_meta[kind]
        detail["editableProps"] = sorted(kind_meta["union"])
        detail["editablePropsIntersection"] = sorted(kind_meta["intersection"] or set())
        detail["editablePropVariants"] = [
            {
                "editableProps": list(props),
                "count": count,
            }
            for props, count in sorted(kind_meta["variants"].items())
        ]
        
    unsupported_artists = [
        {"class": cls, "count": count, "reason": f"Type {cls} is not currently supported for interactive editing"}
        for cls, count in unsupported_map.items()
    ]
    
    coverage_report = {
        "summary": {
            "recognized": recognized_count,
            "editable": editable_count,
            "readonly": readonly_count,
            "unsupported": sum(unsupported_map.values()),
            "semantic": dedicated_count,
            "dedicated": dedicated_count,
            "flattened": flattened_count,
            "ambiguous": ambiguous_count,
        },
        "byKind": by_kind,
        "unsupportedArtists": unsupported_artists,
        "complexArtists": complex_artists,
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
        "renderViewport": render_viewport,
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


def _is_legend_collection_handle(handle: Any) -> bool:
    try:
        import matplotlib.collections as mcoll
        return isinstance(handle, mcoll.Collection)
    except Exception:
        return hasattr(handle, "get_sizes")


def _normalized_legend_label(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _series_axes_for_legend_match(artist: Any) -> Any:
    axes = getattr(artist, "axes", None)
    if axes is not None:
        return axes
    try:
        for child in artist.get_children():
            child_axes = getattr(child, "axes", None)
            if child_axes is not None:
                return child_axes
    except Exception:
        pass
    return None


def _build_label_matched_series_legend_relationships(
    raw_elements,
    artist_to_gid,
    series_kinds: set[str],
) -> dict:
    series_entries = []
    for series_gid, series_kind, series_artist in raw_elements:
        if series_kind not in series_kinds:
            continue
        normalized_label = _normalized_legend_label(_safe_artist_label(series_artist, ""))
        if not normalized_label or normalized_label.startswith("_"):
            continue
        series_entries.append((series_gid, _series_axes_for_legend_match(series_artist), normalized_label))

    label_counts = {}
    for _, axes, normalized_label in series_entries:
        key = (axes, normalized_label)
        label_counts[key] = label_counts.get(key, 0) + 1

    relationships = {}
    for series_gid, axes, normalized_label in series_entries:
        if label_counts.get((axes, normalized_label)) != 1:
            continue
        matching_marker_gids = []
        for _, legend_kind, legend in raw_elements:
            if legend_kind != "legend" or getattr(legend, "axes", None) is not axes:
                continue
            handles = _get_legend_handles(legend)
            for index, text in enumerate(legend.get_texts()):
                if index >= len(handles):
                    continue
                text_label = _normalized_legend_label(text.get_text())
                marker_gid = artist_to_gid.get(handles[index])
                if text_label == normalized_label and marker_gid:
                    matching_marker_gids.append(marker_gid)
        matching_marker_gids = list(dict.fromkeys(matching_marker_gids))
        if len(matching_marker_gids) != 1:
            continue
        marker_gid = matching_marker_gids[0]
        relationships.setdefault(series_gid, {})["legendMarkerIds"] = [marker_gid]
        relationships.setdefault(marker_gid, {})["parentId"] = series_gid
    return relationships


def _matching_legend_marker_gids(
    raw_elements,
    artist_to_gid,
    axes: Any,
    normalized_label: str,
    global_label_count: int,
) -> list[str]:
    marker_gids = []
    for _, legend_kind, legend in raw_elements:
        if legend_kind != "legend":
            continue
        legend_axes = getattr(legend, "axes", None)
        if legend_axes is not axes and legend_axes is not None:
            continue
        if legend_axes is None and global_label_count != 1:
            continue
        handles = _get_legend_handles(legend)
        for index, text in enumerate(legend.get_texts()):
            if index >= len(handles):
                continue
            marker_gid = artist_to_gid.get(handles[index])
            if _normalized_legend_label(text.get_text()) == normalized_label and marker_gid:
                marker_gids.append(marker_gid)
    return list(dict.fromkeys(marker_gids))


def _build_histogram_legend_relationships(raw_elements, artist_to_gid) -> dict:
    entries = []
    for histogram_gid, histogram_kind, histogram_artist in raw_elements:
        provenance = _intercepted_complex_artists.get(histogram_artist, {})
        normalized_label = _normalized_legend_label(provenance.get("legendLabel"))
        if (
            histogram_kind not in {"bar_container", "patch"}
            or provenance.get("family") != "hist"
            or not normalized_label
        ):
            continue
        entries.append((histogram_gid, provenance.get("axes"), normalized_label))

    local_counts = {}
    global_counts = {}
    for _, axes, normalized_label in entries:
        local_key = (axes, normalized_label)
        local_counts[local_key] = local_counts.get(local_key, 0) + 1
        global_counts[normalized_label] = global_counts.get(normalized_label, 0) + 1

    relationships = {}
    for histogram_gid, axes, normalized_label in entries:
        if local_counts.get((axes, normalized_label)) != 1:
            continue
        marker_gids = _matching_legend_marker_gids(
            raw_elements,
            artist_to_gid,
            axes,
            normalized_label,
            global_counts.get(normalized_label, 0),
        )
        if len(marker_gids) != 1:
            continue
        marker_gid = marker_gids[0]
        relationships.setdefault(histogram_gid, {})["legendMarkerIds"] = [marker_gid]
        relationships.setdefault(marker_gid, {})["parentId"] = histogram_gid
    return relationships


def _build_vector_field_legend_relationships(raw_elements, artist_to_gid) -> dict:
    entries = []
    for field_gid, field_kind, field_artist in raw_elements:
        if field_kind not in {"quiver", "streamplot"}:
            continue
        provenance = _intercepted_complex_artists.get(field_artist, {})
        normalized_label = _normalized_legend_label(_safe_artist_label(field_artist, ""))
        if not normalized_label or normalized_label.startswith("_"):
            continue
        relation_name = "quiverId" if field_kind == "quiver" else "streamplotId"
        entries.append((
            field_gid,
            provenance.get("axes") or _series_axes_for_legend_match(field_artist),
            normalized_label,
            relation_name,
            provenance.get(relation_name),
            artist_to_gid.get(provenance.get("lineArtist")),
        ))

    local_counts = {}
    global_counts = {}
    for _, axes, normalized_label, _, _, _ in entries:
        local_key = (axes, normalized_label)
        local_counts[local_key] = local_counts.get(local_key, 0) + 1
        global_counts[normalized_label] = global_counts.get(normalized_label, 0) + 1

    relationships = {}
    for field_gid, axes, normalized_label, relation_name, relation_value, line_collection_id in entries:
        if local_counts.get((axes, normalized_label)) != 1:
            continue
        marker_gids = _matching_legend_marker_gids(
            raw_elements,
            artist_to_gid,
            axes,
            normalized_label,
            global_counts.get(normalized_label, 0),
        )
        if len(marker_gids) != 1:
            continue
        marker_gid = marker_gids[0]
        field_relationships = relationships.setdefault(field_gid, {})
        field_relationships["legendMarkerIds"] = [marker_gid]
        if relation_value:
            field_relationships[relation_name] = relation_value
        if line_collection_id:
            field_relationships["lineCollectionId"] = line_collection_id
        marker_relationships = relationships.setdefault(marker_gid, {})
        marker_relationships["parentId"] = field_gid
        if relation_value:
            marker_relationships[relation_name] = relation_value
    return relationships


def _build_pie_legend_relationships(raw_elements, artist_to_gid) -> dict:
    relationships = {}
    pie_slices = []
    for slice_gid, slice_kind, slice_artist in raw_elements:
        provenance = _intercepted_complex_artists.get(slice_artist, {})
        if slice_kind != "patch" or provenance.get("semanticRole") != "pie_slice":
            continue
        label_gid = artist_to_gid.get(provenance.get("labelArtist"))
        value_label_gid = artist_to_gid.get(provenance.get("valueLabelArtist"))
        relation = {
            "pieId": provenance.get("pieId"),
            "sliceIndex": provenance.get("sliceIndex"),
            "pieLabelId": label_gid,
            "pieValueLabelId": value_label_gid,
        }
        relationships[slice_gid] = {
            key: value for key, value in relation.items() if value is not None
        }
        for text_gid in (label_gid, value_label_gid):
            if text_gid:
                relationships[text_gid] = {
                    "pieId": provenance.get("pieId"),
                    "sliceIndex": provenance.get("sliceIndex"),
                    "pieSliceId": slice_gid,
                }
        pie_slices.append((
            slice_gid,
            provenance.get("axes"),
            _normalized_legend_label(provenance.get("legendLabel")),
        ))

    label_counts = {}
    global_label_counts = {}
    for _, axes, normalized_label in pie_slices:
        if normalized_label:
            key = (axes, normalized_label)
            label_counts[key] = label_counts.get(key, 0) + 1
            global_label_counts[normalized_label] = global_label_counts.get(normalized_label, 0) + 1

    for slice_gid, axes, normalized_label in pie_slices:
        if not normalized_label or label_counts.get((axes, normalized_label)) != 1:
            continue
        marker_gids = []
        for _, legend_kind, legend in raw_elements:
            if legend_kind != "legend":
                continue
            legend_axes = getattr(legend, "axes", None)
            if legend_axes is not axes and legend_axes is not None:
                continue
            if legend_axes is None and global_label_counts.get(normalized_label) != 1:
                continue
            handles = _get_legend_handles(legend)
            for index, text in enumerate(legend.get_texts()):
                if index >= len(handles):
                    continue
                marker_gid = artist_to_gid.get(handles[index])
                if _normalized_legend_label(text.get_text()) == normalized_label and marker_gid:
                    marker_gids.append(marker_gid)
        marker_gids = list(dict.fromkeys(marker_gids))
        if len(marker_gids) != 1:
            continue
        marker_gid = marker_gids[0]
        relationships.setdefault(slice_gid, {})["legendMarkerIds"] = [marker_gid]
        relationships.setdefault(marker_gid, {}).update({
            "parentId": slice_gid,
            "pieId": relationships.get(slice_gid, {}).get("pieId"),
            "sliceIndex": relationships.get(slice_gid, {}).get("sliceIndex"),
            "pieSliceId": slice_gid,
        })
    return relationships


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


_TEXT_BBOX_PROPS = {
    "bbox_visible",
    "bbox_facecolor",
    "bbox_edgecolor",
    "bbox_alpha",
    "bbox_linewidth",
    "bbox_pad",
    "bbox_boxstyle",
}


def _ensure_text_bbox_patch(artist: Any):
    patch = getattr(artist, "get_bbox_patch", lambda: None)()
    if patch is not None:
        return patch
    artist.set_bbox({
        "boxstyle": "round,pad=0.3",
        "facecolor": "white",
        "edgecolor": "black",
        "linewidth": 0.8,
        "alpha": 1.0,
    })
    return artist.get_bbox_patch()


def _text_bbox_boxstyle_name(patch: Any) -> str:
    try:
        return type(patch.get_boxstyle()).__name__.lower()
    except Exception:
        return "round"


def _text_bbox_pad(patch: Any) -> float:
    try:
        return float(getattr(patch.get_boxstyle(), "pad", 0.3))
    except Exception:
        return 0.3


def _apply_text_bbox_patch(artist: Any, prop: str, value: Any):
    if not hasattr(artist, "set_bbox"):
        return "unsupported_text_bbox"
    if prop == "bbox_visible" and not bool(value):
        patch = getattr(artist, "get_bbox_patch", lambda: None)()
        if patch is not None:
            patch.set_visible(False)
        return None
    patch = _ensure_text_bbox_patch(artist)
    if patch is None:
        return "unsupported_text_bbox"
    patch.set_visible(True)
    try:
        if prop == "bbox_visible":
            patch.set_visible(bool(value))
        elif prop == "bbox_facecolor":
            patch.set_facecolor(value)
        elif prop == "bbox_edgecolor":
            patch.set_edgecolor(value)
        elif prop == "bbox_alpha":
            patch.set_alpha(float(value))
        elif prop == "bbox_linewidth":
            patch.set_linewidth(max(0.0, float(value)))
        elif prop == "bbox_pad":
            patch.set_boxstyle(_text_bbox_boxstyle_name(patch), pad=max(0.0, float(value)))
        elif prop == "bbox_boxstyle":
            boxstyle = str(value).strip().lower()
            if boxstyle not in {"round", "square", "round4", "sawtooth"}:
                return "unsupported_bbox_boxstyle"
            patch.set_boxstyle(boxstyle, pad=_text_bbox_pad(patch))
        else:
            return "unsupported_prop"
    except (TypeError, ValueError):
        return "invalid_text_bbox_value"
    return None


def _apply_radar_label_offset(artist: Any, value: Any):
    metadata = _radar_metadata_for_artist(artist)
    if not metadata or metadata.get("radarSemanticRole") != "dimension_label":
        return "unsupported_radar_label_offset"
    if not isinstance(value, dict):
        return "invalid_radar_label_offset"
    try:
        dx = float(value.get("dx", getattr(artist, "_scifigure_radar_label_dx", 0.0) or 0.0))
        dy = float(value.get("dy", getattr(artist, "_scifigure_radar_label_dy", 0.0) or 0.0))
    except (TypeError, ValueError):
        return "invalid_radar_label_offset"
    if not np.isfinite(dx) or not np.isfinite(dy) or max(abs(dx), abs(dy)) > 500:
        return "invalid_radar_label_offset"
    fig = getattr(artist, "figure", None)
    if fig is None:
        return "unsupported_radar_label_offset"

    if not getattr(artist, "_scifigure_radar_offset_draw_installed", False):
        original_draw = artist.draw

        def draw_with_radar_offset(renderer):
            current_dx = float(getattr(artist, "_scifigure_radar_label_dx", 0.0) or 0.0)
            current_dy = float(getattr(artist, "_scifigure_radar_label_dy", 0.0) or 0.0)
            if current_dx == 0.0 and current_dy == 0.0:
                return original_draw(renderer)

            current_transform = artist.get_transform()
            current_figure = getattr(artist, "figure", None)
            if current_figure is None:
                return original_draw(renderer)

            from matplotlib.transforms import ScaledTranslation
            offset = ScaledTranslation(
                current_dx / 72.0,
                current_dy / 72.0,
                current_figure.dpi_scale_trans,
            )
            artist.set_transform(current_transform + offset)
            try:
                return original_draw(renderer)
            finally:
                artist.set_transform(current_transform)

        artist.draw = draw_with_radar_offset
        setattr(artist, "_scifigure_radar_offset_draw_installed", True)

    setattr(artist, "_scifigure_radar_label_dx", dx)
    setattr(artist, "_scifigure_radar_label_dy", dy)
    return None

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


def _refresh_contour_mappable(artist) -> None:
    changed = getattr(artist, "changed", None)
    if callable(changed):
        try:
            changed()
        except Exception:
            pass
    colorbar = getattr(artist, "colorbar", None)
    if colorbar is not None:
        try:
            colorbar.update_normal(artist)
        except Exception:
            pass


def _apply_contour_patch(artist, prop: str, value: Any):
    if prop == "cmap":
        artist.set_cmap(value)
    elif prop in {"vmin", "vmax"}:
        current_vmin, current_vmax = artist.get_clim()
        if prop == "vmin":
            artist.set_clim(vmin=float(value), vmax=current_vmax)
        else:
            artist.set_clim(vmin=current_vmin, vmax=float(value))
    elif prop == "alpha":
        artist.set_alpha(float(value))
        for child in _contour_owned_collections(artist):
            if child is artist:
                continue
            setter = getattr(child, "set_alpha", None)
            if callable(setter):
                setter(float(value))
    elif prop in {"linewidth", "linestyle", "visible", "zorder"}:
        setter_name = {
            "linewidth": "set_linewidth",
            "linestyle": "set_linestyle",
            "visible": "set_visible",
            "zorder": "set_zorder",
        }[prop]
        converted = (
            float(value) if prop in {"linewidth", "zorder"}
            else bool(value) if prop == "visible"
            else value
        )
        applied = False
        for child in _contour_owned_collections(artist):
            setter = getattr(child, setter_name, None)
            if not callable(setter):
                plural_setter = getattr(child, f"{setter_name}s", None)
                setter = plural_setter if callable(plural_setter) else None
            if callable(setter):
                setter(converted)
                applied = True
        if not applied:
            return "no_setter"
        provenance = _intercepted_complex_artists.get(artist)
        if provenance is not None and prop in {"linewidth", "linestyle"}:
            provenance[prop] = converted
    else:
        return "unsupported_prop"

    _refresh_contour_mappable(artist)
    return None


def _apply_quiver_patch(artist, prop: str, value: Any):
    if prop == "color":
        artist.set_color(value)
    elif prop == "facecolor":
        artist.set_facecolor(value)
    elif prop == "edgecolor":
        artist.set_edgecolor(value)
    elif prop == "alpha":
        artist.set_alpha(float(value))
    elif prop == "linewidth":
        artist.set_linewidth(float(value))
    elif prop == "visible":
        artist.set_visible(bool(value))
    elif prop == "zorder":
        artist.set_zorder(float(value))
    else:
        return "unsupported_prop"
    return None


def _apply_streamplot_patch(container, prop: str, value: Any):
    children = container.get_children()
    if not children:
        return "missing_streamplot_children"
    if prop not in {"color", "alpha", "linewidth", "visible", "zorder"}:
        return "unsupported_prop"

    for child in children:
        if prop == "color":
            setter = getattr(child, "set_color", None)
            if not callable(setter):
                return "no_setter"
            setter(value)
        elif prop == "alpha":
            child.set_alpha(float(value))
        elif prop == "linewidth":
            setter = getattr(child, "set_linewidth", None)
            if not callable(setter):
                setter = getattr(child, "set_linewidths", None)
            if not callable(setter):
                return "no_setter"
            setter(float(value))
        elif prop == "visible":
            child.set_visible(bool(value))
        elif prop == "zorder":
            child.set_zorder(float(value))
    return None


def _apply_single(artist, prop: str, value: Any, gid: str = ""):
    if _is_diagram_structural_prop(artist, prop):
        return "unsupported_prop"

    if gid.startswith(("xtick.", "ytick.")) and prop == "text":
        _set_tick_label_text_override(artist, gid, value)
        return

    if prop == "radar_label_offset":
        return _apply_radar_label_offset(artist, value)

    if prop in _TEXT_BBOX_PROPS:
        return _apply_text_bbox_patch(artist, prop, value)

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

    if gid.startswith(("container.contour.", "container.contourf.")):
        return _apply_contour_patch(artist, prop, value)

    if _intercepted_complex_artists.get(artist, {}).get("family") == "quiver":
        return _apply_quiver_patch(artist, prop, value)

    if gid.startswith("container.streamplot."):
        return _apply_streamplot_patch(artist, prop, value)

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
        if prop not in {"color", "facecolor", "edgecolor", "linewidth", "alpha", "zorder"}:
            return "unsupported_prop"
        for child in artist:
            if prop == "color" or prop == "facecolor":
                child.set_facecolor(value)
            elif prop == "edgecolor":
                child.set_edgecolor(value)
            elif prop == "linewidth":
                child.set_linewidth(float(value))
            elif prop == "alpha":
                child.set_alpha(float(value))
            elif prop == "zorder":
                child.set_zorder(float(value))
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

    if gid.startswith("axis.x.") or gid.startswith("axis.y.") or gid.startswith("axis.z."):
        axis_name = "x" if gid.startswith("axis.x.") else "y" if gid.startswith("axis.y.") else "z"
        parent_ax = artist.axes
        prop = {
            "fontsize": "tick_labelsize",
            "fontfamily": "tick_labelfamily",
            "color": "tick_labelcolor",
            "fontweight": "tick_fontweight",
            "fontstyle": "tick_fontstyle",
        }.get(prop, prop)
        if prop == "limits":
            low = float(value[0])
            high = float(value[1])
            if axis_name == "x":
                parent_ax.set_xlim(low, high)
            elif axis_name == "y":
                parent_ax.set_ylim(low, high)
            else:
                parent_ax.set_zlim(low, high)
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
        absolute_size = float(value)
        artist.set_sizes([absolute_size])
        setattr(artist, "_scifigure_base_sizes", [absolute_size])
        setattr(artist, "_scifigure_size_scale", 1.0)
        return

    if prop == "size_scale" and hasattr(artist, "get_sizes") and hasattr(artist, "set_sizes"):
        scale = float(value)
        if scale <= 0:
            return "invalid_size_scale"
        sizes = artist.get_sizes()
        if sizes is None or len(sizes) == 0:
            return "no_sizes_to_scale"
        base_sizes = getattr(artist, "_scifigure_base_sizes", None)
        if not isinstance(base_sizes, (list, tuple)) or len(base_sizes) == 0:
            base_sizes = [float(size) for size in sizes]
            setattr(artist, "_scifigure_base_sizes", base_sizes)
        artist.set_sizes([float(size) * scale for size in base_sizes])
        setattr(artist, "_scifigure_size_scale", scale)
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


def _axes_index_from_gid(gid: str) -> int:
    ax_idx = 0
    axes_legend_match = re.match(
        r"^(?:legend|legend_(?:title|text|line|patch|collection))\.(\d+)(?:\.|$)",
        gid,
    )
    if axes_legend_match:
        return int(axes_legend_match.group(1))
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
    return ax_idx


def _build_gid_index(fig) -> dict:
    """Rebuild gid → artist metadata via iter_artists (same source as introspect)."""
    raw_elements = []
    for gid, kind, artist in iter_artists(fig):
        if artist is None:
            continue
        _register_explicit_diagram_artist(artist)
        raw_elements.append((gid, kind, artist))
    _bind_raw_element_axes_contexts(raw_elements)
    artist_to_gid = {artist: gid for gid, kind, artist in raw_elements}
    for gid, kind, artist in raw_elements:
        if kind in {"contour", "contourf"}:
            artist_to_gid[artist] = gid
    subplot_meta = _build_subplot_layout_meta(raw_elements)
    child_to_parent = {}
    relation_metadata = {}

    for legend_gid, kind, legend in raw_elements:
        if kind != "legend":
            continue
        title_gid = artist_to_gid.get(legend.get_title())
        text_gids = [artist_to_gid.get(text) for text in legend.get_texts()]
        marker_gids = [artist_to_gid.get(handle) for handle in _get_legend_handles(legend)]
        relation_metadata.setdefault(legend_gid, {}).update({
            "legendTitleId": title_gid,
            "legendTextIds": [child_gid for child_gid in text_gids if child_gid],
            "legendMarkerIds": [child_gid for child_gid in marker_gids if child_gid],
        })
        for entry_index, marker_gid in enumerate(marker_gids):
            text_gid = text_gids[entry_index] if entry_index < len(text_gids) else None
            if marker_gid and text_gid:
                relation_metadata.setdefault(marker_gid, {})["legendTextId"] = text_gid
    for gid, relationships in _build_label_matched_series_legend_relationships(
        raw_elements,
        artist_to_gid,
        {"errorbar_container"},
    ).items():
        relation_metadata.setdefault(gid, {}).update(relationships)
    for gid, relationships in _build_pie_legend_relationships(
        raw_elements,
        artist_to_gid,
    ).items():
        relation_metadata.setdefault(gid, {}).update(relationships)
    for gid, relationships in _build_histogram_legend_relationships(
        raw_elements,
        artist_to_gid,
    ).items():
        relation_metadata.setdefault(gid, {}).update(relationships)
    for gid, relationships in _build_vector_field_legend_relationships(
        raw_elements,
        artist_to_gid,
    ).items():
        relation_metadata.setdefault(gid, {}).update(relationships)

    for gid, kind, artist in raw_elements:
        if kind not in _PARENT_OBJECT_KINDS:
            continue

        children_gids = _parent_child_gids(kind, artist, raw_elements, artist_to_gid)
        relation_kind = _parent_relation_kind(kind, artist)

        for child_gid in children_gids:
            child_to_parent[child_gid] = (gid, relation_kind)

    return {
        gid: {
            "kind": kind,
            "artist": artist,
            "parent": child_to_parent.get(gid),
            "subplotMeta": subplot_meta.get(gid, {}),
            "relationMetadata": relation_metadata.get(gid, {}),
        }
        for gid, kind, artist in raw_elements
    }


def _build_gid_map(fig) -> dict:
    """Rebuild gid → artist mapping via iter_artists (same as introspect)."""
    return {
        gid: item["artist"]
        for gid, item in _build_gid_index(fig).items()
    }


def _errorbar_legend_marker_gids_for_target(gid: str, gid_index: dict) -> list[str]:
    gid_info = gid_index.get(gid, {})
    parent_gid = gid if gid.startswith("container.errorbar.") else None
    if parent_gid is None:
        parent_info = gid_info.get("parent")
        if parent_info and parent_info[1] == "errorbar_container":
            parent_gid = parent_info[0]
    if not parent_gid:
        return []
    relation_metadata = gid_index.get(parent_gid, {}).get("relationMetadata", {})
    marker_gids = relation_metadata.get("legendMarkerIds", [])
    if not isinstance(marker_gids, list):
        return []
    return [marker_gid for marker_gid in marker_gids if isinstance(marker_gid, str)]


def _mirror_errorbar_color_to_legend_markers(
    gid: str,
    prop: str,
    value: Any,
    gid_index: dict,
    gid_map: dict,
) -> list[dict]:
    if prop != "color":
        return []
    warnings = []
    for marker_gid in _errorbar_legend_marker_gids_for_target(gid, gid_index):
        marker = gid_map.get(marker_gid)
        if marker is None:
            continue
        result = _apply_single(marker, "color", value, marker_gid)
        if result is not None:
            warnings.append({
                "type": result,
                "mode": "backend_patch",
                "gid": marker_gid,
                "prop": "color",
                "value": value,
                "artist": type(marker).__name__,
            })
    return warnings


def _entry_identity_metadata(entry: dict) -> dict:
    expected = {}
    if "stableKey" in entry:
        expected["stableKey"] = entry.get("stableKey")
    if entry.get("fingerprintVersion") == 2 and "fingerprint" in entry:
        expected["fingerprint"] = entry.get("fingerprint")

    identity = entry.get("identity")
    if isinstance(identity, dict) and "seriesKey" in identity:
        expected["seriesKey"] = identity.get("seriesKey")
    diagram_relation = _diagram_relation_signature(identity)
    if diagram_relation is not None:
        expected["diagramRelationSignature"] = diagram_relation
    special_axes_relation = _special_axes_relation_signature(identity)
    if special_axes_relation is not None:
        expected["specialAxesRelationSignature"] = special_axes_relation
    if entry.get("fingerprintVersion") == 2:
        legend_marker_relation = _legend_marker_relation_signature(identity)
        if legend_marker_relation is not None:
            expected["legendMarkerRelationSignature"] = legend_marker_relation
        semantic_parent_relation = _semantic_parent_relation_signature(identity)
        if semantic_parent_relation is not None:
            expected["semanticParentRelationSignature"] = semantic_parent_relation

    return {
        key: value
        for key, value in expected.items()
        if value is not None
    }


def _current_identity_signature(
    gid: str,
    kind: str,
    artist: Any,
    parent_info=None,
    subplot_meta: Optional[dict] = None,
    relation_metadata: Optional[dict] = None,
) -> dict:
    current_props = _read_props(artist, kind)
    label = _safe_artist_label(artist, gid)
    provenance = _intercepted_complex_artists.get(artist, {})
    if provenance.get("family") == "hist" and provenance.get("legendLabel"):
        label = str(provenance["legendLabel"])
    if provenance.get("semanticRole") in {"pie_label", "pie_value_label"}:
        label = str(getattr(artist, "get_text", lambda: label)())
    if provenance.get("semanticRole") in _DIAGRAM_PROTECTED_TEXT_ROLES:
        label = str(getattr(artist, "get_text", lambda: label)())
    if kind == "subplot":
        meta = subplot_meta or {}
        label = meta.get("label", label)
        current_props = {
            **current_props,
            "subplotIndex": meta.get("subplotIndex", 0),
            "row": meta.get("row", 0),
            "col": meta.get("col", 0),
            "label": label,
        }

    obj = {
        "id": gid,
        "kind": kind,
        "label": label,
        "currentProps": current_props,
    }
    parent_kind = None
    if parent_info:
        parent_id, parent_kind = parent_info
        obj["parentId"] = parent_id
    for relation_name, relation_value in (relation_metadata or {}).items():
        if relation_value is not None:
            obj[relation_name] = relation_value
    role = _determine_role(gid, parent_kind, kind, artist)
    if role:
        obj["role"] = role
    _apply_diagram_metadata_to_object(obj, artist)
    _apply_axes_relation_metadata(obj, artist)
    _apply_radar_metadata_to_object(obj, artist)

    stable_key, fingerprint = _generate_stable_key_and_fingerprint(
        obj,
        artist,
        int((_axes_context_for_artist(artist) or {}).get("axesIndex", _axes_index_from_gid(gid))),
    )
    obj["stableKey"] = stable_key
    obj["fingerprint"] = fingerprint
    identity = _build_object_identity(obj)
    signature = {
        "stableKey": stable_key,
        "fingerprint": fingerprint,
        "seriesKey": identity.get("seriesKey"),
    }
    if kind == "collection":
        signature["legacyWeakFingerprint"] = _legacy_weak_collection_fingerprint(stable_key, artist)
        signature["collectionSiblingCount"] = _collection_sibling_count(artist)
    diagram_relation = _diagram_relation_signature(identity)
    if diagram_relation is not None:
        signature["diagramRelationSignature"] = diagram_relation
    special_axes_relation = _special_axes_relation_signature(identity)
    if special_axes_relation is not None:
        signature["specialAxesRelationSignature"] = special_axes_relation
    legend_marker_relation = _legend_marker_relation_signature(identity)
    if legend_marker_relation is not None:
        signature["legendMarkerRelationSignature"] = legend_marker_relation
    semantic_parent_relation = _semantic_parent_relation_signature(identity)
    if semantic_parent_relation is not None:
        signature["semanticParentRelationSignature"] = semantic_parent_relation
    return signature


def _identity_mismatch_warning(gid: str, prop: str, mode: str, value: Any, expected: dict, actual: dict, artist: Any) -> dict:
    mismatches = [
        key
        for key, expected_value in expected.items()
        if expected_value != actual.get(key)
    ]
    if "diagramRelationSignature" in mismatches:
        expected_relation = expected.get("diagramRelationSignature")
        actual_relation = actual.get("diagramRelationSignature")
        relation_mismatches = [
            f"identity.relation.{field}"
            for field in _DIAGRAM_RELATION_FIELDS
            if (
                expected_relation.get(field) if isinstance(expected_relation, dict) else None
            ) != (
                actual_relation.get(field) if isinstance(actual_relation, dict) else None
            )
        ]
        mismatches = [
            *[key for key in mismatches if key != "diagramRelationSignature"],
            *(relation_mismatches or ["identity.relation"]),
        ]
    if "specialAxesRelationSignature" in mismatches:
        expected_relation = expected.get("specialAxesRelationSignature")
        actual_relation = actual.get("specialAxesRelationSignature")
        relation_mismatches = [
            f"identity.relation.{field}"
            for field in _SPECIAL_AXES_RELATION_FIELDS
            if (
                expected_relation.get(field) if isinstance(expected_relation, dict) else None
            ) != (
                actual_relation.get(field) if isinstance(actual_relation, dict) else None
            )
        ]
        mismatches = [
            *[key for key in mismatches if key != "specialAxesRelationSignature"],
            *(relation_mismatches or ["identity.relation"]),
        ]
    if "legendMarkerRelationSignature" in mismatches:
        expected_relation = expected.get("legendMarkerRelationSignature")
        actual_relation = actual.get("legendMarkerRelationSignature")
        relation_mismatches = [
            f"identity.relation.{field}"
            for field in _LEGEND_MARKER_RELATION_FIELDS
            if (
                expected_relation.get(field) if isinstance(expected_relation, dict) else None
            ) != (
                actual_relation.get(field) if isinstance(actual_relation, dict) else None
            )
        ]
        mismatches = [
            *[key for key in mismatches if key != "legendMarkerRelationSignature"],
            *(relation_mismatches or ["identity.relation"]),
        ]
    if "semanticParentRelationSignature" in mismatches:
        expected_relation = expected.get("semanticParentRelationSignature")
        actual_relation = actual.get("semanticParentRelationSignature")
        relation_mismatches = [
            f"identity.relation.{field}"
            for field in _SEMANTIC_PARENT_RELATION_FIELDS
            if (
                expected_relation.get(field) if isinstance(expected_relation, dict) else None
            ) != (
                actual_relation.get(field) if isinstance(actual_relation, dict) else None
            )
        ]
        mismatches = [
            *[key for key in mismatches if key != "semanticParentRelationSignature"],
            *(relation_mismatches or ["identity.relation"]),
        ]
    return {
        "type": "identity_mismatch",
        "mode": mode,
        "gid": gid,
        "prop": prop,
        "value": value,
        "artist": type(artist).__name__,
        "expected": expected,
        "actual": actual,
        "mismatches": mismatches,
    }


def _is_compatible_contour_child_fingerprint_drift(
    gid_info: dict,
    expected: dict,
    actual: dict,
    mismatches: list[str],
) -> bool:
    parent_info = gid_info.get("parent")
    parent_kind = parent_info[1] if parent_info else None
    return (
        gid_info.get("kind") == "collection"
        and parent_kind in {"contour", "contourf"}
        and set(mismatches) == {"fingerprint"}
        and "stableKey" in expected
        and "seriesKey" in expected
        and expected["stableKey"] == actual.get("stableKey")
        and expected["seriesKey"] == actual.get("seriesKey")
    )


def _is_compatible_legacy_weak_collection_fingerprint(
    expected: dict,
    actual: dict,
    mismatches: list[str],
) -> bool:
    """Allow old collection fingerprints only when no sibling can be confused."""
    return (
        set(mismatches) == {"fingerprint"}
        and "stableKey" in expected
        and expected.get("stableKey") == actual.get("stableKey")
        and expected.get("fingerprint") == actual.get("legacyWeakFingerprint")
        and int(actual.get("collectionSiblingCount") or 0) <= 1
    )


def _is_compatible_legacy_legend_collection_fingerprint(
    gid: str,
    expected: dict,
    actual: dict,
    mismatches: list[str],
) -> bool:
    """Accept layout-dependent v2 legend fingerprints only with full identity proof."""
    return (
        gid.startswith("legend_collection.")
        and set(mismatches) == {"fingerprint"}
        and all(
            key in expected
            for key in ("stableKey", "seriesKey", "legendMarkerRelationSignature")
        )
        and expected.get("stableKey") == actual.get("stableKey")
        and expected.get("seriesKey") == actual.get("seriesKey")
        and expected.get("legendMarkerRelationSignature")
        == actual.get("legendMarkerRelationSignature")
    )


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
    gid_index = _build_gid_index(fig)
    gid_map = {
        gid: item["artist"]
        for gid, item in gid_index.items()
    }
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
            warnings.append({
                "type": "missing_gid",
                "mode": mode,
                "gid": gid,
                "prop": prop,
                "value": value,
            })
            continue

        expected_identity = _entry_identity_metadata(entry)
        diagram_provenance = _register_explicit_diagram_artist(artist)
        actual_is_diagram = bool(
            diagram_provenance
            and diagram_provenance.get("family") == "diagram"
        )
        if expected_identity or actual_is_diagram:
            gid_info = gid_index.get(gid, {})
            actual_identity = _current_identity_signature(
                gid,
                gid_info.get("kind", ""),
                artist,
                parent_info=gid_info.get("parent"),
                subplot_meta=gid_info.get("subplotMeta"),
                relation_metadata=gid_info.get("relationMetadata"),
            )
            if actual_is_diagram and "diagramRelationSignature" not in expected_identity:
                expected_identity["diagramRelationSignature"] = None
            identity_mismatches = [
                key
                for key, expected in expected_identity.items()
                if expected != actual_identity.get(key)
            ]
            if identity_mismatches and not _is_compatible_contour_child_fingerprint_drift(
                gid_info,
                expected_identity,
                actual_identity,
                identity_mismatches,
            ) and not _is_compatible_legacy_weak_collection_fingerprint(
                expected_identity,
                actual_identity,
                identity_mismatches,
            ) and not _is_compatible_legacy_legend_collection_fingerprint(
                gid,
                expected_identity,
                actual_identity,
                identity_mismatches,
            ):
                warnings.append(_identity_mismatch_warning(
                    gid,
                    prop,
                    mode,
                    value,
                    expected_identity,
                    actual_identity,
                    artist,
                ))
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
        ) or (
            prop == "radar_label_offset"
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
        else:
            warnings.extend(_mirror_errorbar_color_to_legend_markers(
                gid,
                prop,
                value,
                gid_index,
                gid_map,
            ))

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
    "quiver",
    "streamplot",
    "stairs",
    "step",
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
        "layoutDiagnosticsMs": 0,
        "binaryExportMs": 0,
    }
    determinism_warnings = _scan_determinism_warnings(script)
    layout_warnings: list[dict[str, Any]] = []

    def elapsed_ms(since: float) -> int:
        return max(0, round((time.perf_counter() - since) * 1000))
    
    # Clear the figure registry for this run
    _figure_registry.clear()
    _intercepted_containers.clear()
    _intercepted_complex_artists.clear()

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
        "_scifigure_semantic_gid": _scifigure_semantic_gid,
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
            "determinismWarnings": determinism_warnings,
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
            "determinismWarnings": determinism_warnings,
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
        layout_diagnostics_started = time.perf_counter()
        try:
            figure_layout_warnings = _collect_layout_warnings(fig)
        except Exception:
            figure_layout_warnings = []
        timing_breakdown["layoutDiagnosticsMs"] += elapsed_ms(layout_diagnostics_started)
        for warning in figure_layout_warnings:
            warning["figureId"] = fig_id
        layout_warnings.extend(figure_layout_warnings)

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
            binary_canvas_bbox, _ = _expanded_svg_canvas(fig)
            if fmt == 'tiff':
                from PIL import Image
                png_buf = io.BytesIO()
                fig.savefig(
                    png_buf,
                    format='png',
                    dpi=dpi,
                    bbox_inches=binary_canvas_bbox,
                    pad_inches=0,
                )
                png_buf.seek(0)
                img = Image.open(png_buf)
                img.save(buf, format='TIFF', compression='tiff_lzw', dpi=(dpi, dpi))
            else:
                fig.savefig(
                    buf,
                    format=fmt,
                    dpi=dpi,
                    bbox_inches=binary_canvas_bbox,
                    pad_inches=0,
                )
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
            "layoutWarnings": figure_layout_warnings,
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
    ret["determinismWarnings"] = determinism_warnings
    ret["layoutWarnings"] = layout_warnings
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
