import ast
import re
from typing import Any, Dict, List, Optional

# Match UPPER_CASE = "#HEX"
PATTERN_CONSTANT = re.compile(r'^([A-Z][A-Z0-9_]*)\s*=\s*["\'](\#[0-9A-Fa-f]{6})["\']')

def scan_source(source: str, namespace: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Scans the Matplotlib Python script for semantic color constants and dictionary definitions.
    Uses AST to trace variable usages and fallback to runtime namespace for dynamic values.
    """
    palettes = []
    groups = []
    
    # 1. Parse lines for Regex match (Pattern A) - captures line numbers easily
    lines = source.split('\n')
    for i, line in enumerate(lines, 1):
        m = PATTERN_CONSTANT.match(line.strip())
        if m:
            var_name = m.group(1)
            # e.g., CK_COLOR -> CK
            label = var_name.replace('_COLOR', '').replace('_', ' ').title()
            palettes.append({
                "id": var_name,
                "label": label,
                "color": m.group(2).lower(),
                "source": "constant",
                "line": i
            })
            
    # 2. AST parsing to find dictionaries (Pattern B) and plotting calls
    try:
        tree = ast.parse(source)
        
        # Look for SEMANTIC_COLORS dictionary definition
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
                if isinstance(target, ast.Name) and target.id == "SEMANTIC_COLORS":
                    if isinstance(node.value, ast.Dict):
                        for k, v in zip(node.value.keys, node.value.values):
                            k_val = getattr(k, 'value', getattr(k, 's', None))
                            v_val = getattr(v, 'value', getattr(v, 's', None))
                            if k_val is not None and v_val is not None:
                                palettes.append({
                                    "id": f"dict_{k_val}",
                                    "label": str(k_val),
                                    "color": str(v_val).lower(),
                                    "source": "dict",
                                    "line": node.lineno
                                })

        # Tracing plotting calls: ax.bar, ax.plot, ax.scatter
        # Find calls and check color/label arguments
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                method_name = node.func.attr
                if method_name in ('bar', 'plot', 'scatter'):
                    # Extract arguments
                    color_arg = None
                    label_arg = None
                    for kw in node.keywords:
                        if kw.arg == 'color':
                            # Could be Name (CK_COLOR), Subscript (SEMANTIC_COLORS["CK"]), or Constant ("#123456")
                            if isinstance(kw.value, ast.Name):
                                color_arg = kw.value.id
                            elif isinstance(kw.value, ast.Subscript):
                                if isinstance(kw.value.value, ast.Name) and kw.value.value.id == "SEMANTIC_COLORS":
                                    slice_node = kw.value.slice
                                    slice_val = getattr(slice_node, 'value', getattr(slice_node, 's', None))
                                    if slice_val is not None:
                                        color_arg = f"dict_{slice_val}"
                            elif isinstance(kw.value, ast.Constant):
                                color_arg = kw.value.value
                        elif kw.arg == 'label':
                            if isinstance(kw.value, ast.Constant):
                                label_arg = kw.value.value

                    if label_arg:
                        groups.append({
                            "groupId": f"group_{label_arg}",
                            "label": label_arg,
                            "paletteId": color_arg if color_arg else f"inferred_{label_arg}",
                            "kind": method_name,
                            "line": node.lineno
                        })

    except Exception:
        # Fail-safe if AST parsing fails
        pass

    # 3. Namespace Fallback for dynamic variables/dicts
    if namespace:
        # Check constants in namespace that are uppercase and match hex color
        for key, val in namespace.items():
            if key.isupper() and isinstance(val, str) and re.match(r'^\#[0-9A-Fa-f]{6}$', val):
                # If not already found by regex (e.g. it was dynamically assigned)
                if not any(p["id"] == key for p in palettes):
                    palettes.append({
                        "id": key,
                        "label": key.replace('_COLOR', '').replace('_', ' ').title(),
                        "color": val.lower(),
                        "source": "constant",
                        "line": 0 # Dynamic
                    })
        # Check SEMANTIC_COLORS dict in namespace
        sem_colors = namespace.get("SEMANTIC_COLORS")
        if isinstance(sem_colors, dict):
            for key, val in sem_colors.items():
                if isinstance(val, str) and re.match(r'^\#[0-9A-Fa-f]{6}$', val):
                    dict_id = f"dict_{key}"
                    if not any(p["id"] == dict_id for p in palettes):
                        palettes.append({
                            "id": dict_id,
                            "label": str(key),
                            "color": val.lower(),
                            "source": "dict",
                            "line": 0
                        })

    return {"palettes": palettes, "groups": groups}
