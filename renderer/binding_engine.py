from typing import Any, Dict, List, Optional


ALLOWED_KINDS = {'patch', 'line', 'collection', 'legend_patch', 'legend_line'}

def build_bindings(semantic_manifest: Dict[str, Any], artist_manifest: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Binds GIDs to semantic groups and palettes based on color matching and label matching.
    Filters out non-editable kinds (e.g., text, title, spines, axes).
    """
    bindings = []
    palettes = semantic_manifest.get("palettes", [])
    groups = semantic_manifest.get("groups", [])
    palette_colors = {
        p["id"]: str(p.get("color") or "").lower()
        for p in palettes
        if p.get("id")
    }
    palette_by_id = {p.get("id"): p for p in palettes if p.get("id")}
    palette_ids_by_color: Dict[str, List[str]] = {}
    for palette_id, color in palette_colors.items():
        if color:
            palette_ids_by_color.setdefault(color, []).append(palette_id)
    competing_palette_ids_by_color: Dict[str, List[str]] = {}
    for color, palette_ids in palette_ids_by_color.items():
        active_ids = [
            palette_id for palette_id in palette_ids
            if palette_by_id.get(palette_id, {}).get("usageCount") != 0
        ]
        competing_palette_ids_by_color[color] = active_ids or palette_ids

    group_signatures: Dict[tuple, List[str]] = {}
    for group in groups:
        palette_id = group.get("paletteId")
        signature = (
            _normalize_label(group.get("label")),
            palette_colors.get(palette_id, ""),
        )
        if signature[0] and signature[1]:
            group_signatures.setdefault(signature, []).append(str(palette_id))

    for group in groups:
        palette_id = group.get("paletteId")
        if not palette_id:
            continue
        group_label = group.get("label")
        target_color = palette_colors.get(palette_id)
        signature = (_normalize_label(group_label), target_color or "")
        duplicate_signatures = set(group_signatures.get(signature, []))
        if len(duplicate_signatures) > 1:
            bindings.append(_ambiguous_binding(
                palette_id,
                group.get("groupId") or f"group_{palette_id}",
                "Multiple palette groups share the same exact label and color.",
            ))
            continue

        label_and_color = []
        label_only = []
        color_only = []
        for artist in artist_manifest:
            if artist.get("kind") not in ALLOWED_KINDS:
                continue
            label_match = _normalize_label(artist.get("label")) == _normalize_label(group_label)
            matched_prop = _matching_color_prop(artist, target_color)
            if label_match and matched_prop:
                label_and_color.append(_binding_target(
                    artist, matched_prop, "label_and_color", "exact"
                ))
            elif label_match:
                label_only.append(_binding_target(
                    artist, _default_color_prop(artist), "exact_label", "high"
                ))
            elif matched_prop:
                color_only.append(_binding_target(
                    artist, matched_prop, "unique_color", "conditional"
                ))

        if label_and_color:
            bindings.append(_build_binding(
                palette_id,
                group.get("groupId") or f"group_{palette_id}",
                label_and_color,
                "exact",
            ))
        elif label_only:
            bindings.append(_build_binding(
                palette_id,
                group.get("groupId") or f"group_{palette_id}",
                label_only,
                "semantic",
                ["Palette binding used an exact label because rendered color differed."],
            ))
        elif len(competing_palette_ids_by_color.get(target_color or "", [])) == 1 and color_only:
            bindings.append(_build_binding(
                palette_id,
                group.get("groupId") or f"group_{palette_id}",
                color_only,
                "conditional",
                ["Palette binding used unique rendered color because no exact label matched."],
            ))

    # Real scripts often use vectorized color mapping such as
    # df["cluster"].map(CLUSTER_COLORS).  In that pattern there is no AST-level
    # plotting label to form a semantic group, but the rendered artists still
    # carry the exact palette colors.  Build fallback bindings directly from
    # palette color -> rendered artist color so the palette center has concrete
    # target gids instead of becoming a no-op.
    bound_palette_ids = {binding.get("paletteId") for binding in bindings}
    for palette_id, target_color in palette_colors.items():
        if palette_id in bound_palette_ids or not target_color:
            continue
        duplicate_palette_ids = competing_palette_ids_by_color.get(target_color, [])
        if palette_id not in duplicate_palette_ids:
            # An actually referenced constant with the same color is the
            # authoritative owner; keep the unused alias visible but unbound.
            continue
        if len(duplicate_palette_ids) > 1:
            bindings.append(_ambiguous_binding(
                palette_id,
                f"palette_{palette_id}",
                "Multiple unbound palettes share this color; color-only matching is disabled.",
            ))
            continue

        targets = []
        for artist in artist_manifest:
            if artist.get("kind") not in ALLOWED_KINDS:
                continue
            matched_prop = _matching_color_prop(artist, target_color)
            if matched_prop:
                targets.append(_binding_target(
                    artist, matched_prop, "unique_color", "conditional"
                ))
        if targets:
            bindings.append(_build_binding(
                palette_id,
                f"palette_{palette_id}",
                targets,
                "conditional",
                ["Palette has no semantic group; binding used unique rendered color."],
            ))

    return bindings


def _normalize_label(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _default_color_prop(artist: Dict[str, Any]) -> str:
    props = artist.get("currentProps") or artist.get("props") or {}
    if artist.get("kind") == "line" and "color" in props:
        return "color"
    if "facecolor" in props:
        return "facecolor"
    if "color" in props:
        return "color"
    return "edgecolor"


def _matching_color_prop(artist: Dict[str, Any], target_color: Optional[str]) -> Optional[str]:
    if not target_color:
        return None
    props = artist.get("currentProps") or artist.get("props") or {}
    preferred = ["color", "facecolor", "edgecolor"] if artist.get("kind") == "line" else ["facecolor", "color", "edgecolor"]
    for prop in preferred:
        if _contains_color(props.get(prop), target_color):
            return prop
    return None


def _binding_target(
    artist: Dict[str, Any],
    prop: str,
    match: str,
    confidence: str,
) -> Dict[str, Any]:
    identity = artist.get("identity") or {}
    target = {
        "gid": artist["id"],
        "prop": prop,
        "match": match,
        "confidence": confidence,
    }
    if identity.get("instanceKey"):
        target["instanceKey"] = identity["instanceKey"]
    if identity.get("seriesKey"):
        target["seriesKey"] = identity["seriesKey"]
    props = artist.get("currentProps") or artist.get("props") or {}
    if _is_multi_color_value(props.get(prop)):
        target["replayMode"] = "code_only"
    return target


def _dedupe_targets(targets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    result = []
    seen = set()
    for target in targets:
        key = (target.get("gid"), target.get("prop"))
        if key in seen:
            continue
        seen.add(key)
        result.append(target)
    return result


def _build_binding(
    palette_id: str,
    group_id: str,
    targets: List[Dict[str, Any]],
    target_mode: str,
    warnings: Optional[List[str]] = None,
) -> Dict[str, Any]:
    targets = _dedupe_targets(targets)
    props = [prop for prop in ["facecolor", "color", "edgecolor"] if any(target.get("prop") == prop for target in targets)]
    return {
        "paletteId": palette_id,
        "groupId": group_id,
        "gids": list(dict.fromkeys(target["gid"] for target in targets)),
        "props": props,
        "targetMode": target_mode,
        "targets": targets,
        **({"warnings": warnings} if warnings else {}),
    }


def _ambiguous_binding(palette_id: str, group_id: str, warning: str) -> Dict[str, Any]:
    return {
        "paletteId": palette_id,
        "groupId": group_id,
        "gids": [],
        "props": [],
        "targetMode": "ambiguous",
        "targets": [],
        "warnings": [warning],
    }

def _normalize_color(color_val) -> Optional[str]:
    if color_val is None:
        return None
    if isinstance(color_val, str) and color_val.startswith("#"):
        return color_val.lower()
    if isinstance(color_val, (list, tuple)) and len(color_val) > 0 and isinstance(color_val[0], (list, tuple)):
        first = color_val[0]
        if len(first) < 3:
            return None
        try:
            for row in color_val[1:]:
                if len(row) != len(first) or any(abs(float(a) - float(b)) > 1e-6 for a, b in zip(row, first)):
                    return None
            color_val = first
        except Exception:
            return None
    if isinstance(color_val, (list, tuple)) and len(color_val) >= 3:
        # RGBA float tuple to hex
        try:
            r, g, b = [round(float(c) * 255) for c in color_val[:3]]
            return f"#{r:02x}{g:02x}{b:02x}"
        except Exception:
            return None
    return None

def _contains_color(color_val, target_hex: str) -> bool:
    if not target_hex:
        return False
    normalized = _normalize_color(color_val)
    if normalized == target_hex:
        return True
    if isinstance(color_val, (list, tuple)) and len(color_val) > 0 and isinstance(color_val[0], (list, tuple)):
        for row in color_val:
            if _normalize_color(row) == target_hex:
                return True
    return False

def _is_multi_color_value(color_val) -> bool:
    if not isinstance(color_val, (list, tuple)) or not color_val:
        return False
    if not isinstance(color_val[0], (list, tuple)):
        return False
    colors = {_normalize_color(row) for row in color_val}
    colors.discard(None)
    return len(colors) > 1

def _props_for_gids(gids: List[str], artist_manifest: List[Dict[str, Any]]) -> List[str]:
    artist_by_id = {artist.get("id"): artist for artist in artist_manifest}
    props = set()
    for gid in gids:
        artist = artist_by_id.get(gid)
        if not artist:
            continue
        kind = artist.get("kind")
        current = artist.get("currentProps") or artist.get("props") or {}
        if kind == "line":
            props.add("color")
        elif "facecolor" in current:
            props.add("facecolor")
        elif "color" in current:
            props.add("color")
        if "edgecolor" in current:
            props.add("edgecolor")
    if not props:
        return ["facecolor", "color"]
    ordered = ["facecolor", "color", "edgecolor"]
    return [prop for prop in ordered if prop in props]
