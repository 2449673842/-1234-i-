from typing import Any, Dict, List

def build_bindings(semantic_manifest: Dict[str, Any], artist_manifest: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Binds GIDs to semantic groups and palettes based on color matching and label matching.
    Filters out non-editable kinds (e.g., text, title, spines, axes).
    """
    bindings = []
    
    palettes = semantic_manifest.get("palettes", [])
    groups = semantic_manifest.get("groups", [])
    
    # Kinds that are allowed to participate in binding
    ALLOWED_KINDS = {'patch', 'line', 'collection', 'legend_patch', 'legend_line'}
    
    # Map palette_id -> palette color
    palette_colors = {p["id"]: p["color"].lower() for p in palettes}
    
    # We want to map each group to its GIDs
    for group in groups:
        palette_id = group.get("paletteId")
        if not palette_id:
            continue
            
        group_label = group.get("label")
        target_color = palette_colors.get(palette_id)
        
        matched_gids = []
        
        for artist in artist_manifest:
            kind = artist.get("kind")
            if kind not in ALLOWED_KINDS:
                continue
                
            props = artist.get("currentProps") or artist.get("props") or {}
            
            # Normalize facecolor or color
            artist_color = _normalize_color(props.get("facecolor") or props.get("color"))
            if not artist_color:
                continue
                
            artist_label = artist.get("label") or ""
            
            # Label clean up for comparison (e.g. remove GID prefixes)
            # If the artist is a legend_patch or legend_line, it might have a label matching the group
            is_label_match = (
                group_label.lower() in artist_label.lower() or 
                artist_label.lower() in group_label.lower()
            ) if group_label and artist_label else False
            
            # If colors match
            if target_color and artist_color == target_color:
                # If there are duplicate colors, prioritize matching label
                # If there are no duplicate colors matching target_color in palettes, bind directly
                duplicate_palettes_with_same_color = [pid for pid, col in palette_colors.items() if col == target_color]
                
                if len(duplicate_palettes_with_same_color) > 1:
                    # Duplicate color conflict: resolve using label trace
                    if is_label_match:
                        matched_gids.append(artist["id"])
                else:
                    # Unique color: bind directly
                    matched_gids.append(artist["id"])
            elif is_label_match:
                # Even if color doesn't match perfectly (e.g. small transparency/alpha differences in facecolor),
                # if label matches, we can bind it.
                matched_gids.append(artist["id"])
                
        if matched_gids:
            bindings.append({
                "paletteId": palette_id,
                "groupId": group["groupId"],
                "gids": matched_gids,
                "props": ["facecolor", "color"]
            })
            
    return bindings

def _normalize_color(color_val) -> str | None:
    if color_val is None:
        return None
    if isinstance(color_val, str) and color_val.startswith("#"):
        return color_val.lower()
    if isinstance(color_val, (list, tuple)) and len(color_val) >= 3:
        # RGBA float tuple to hex
        try:
            r, g, b = [int(c * 255) for c in color_val[:3]]
            return f"#{r:02x}{g:02x}{b:02x}"
        except Exception:
            return None
    return None
