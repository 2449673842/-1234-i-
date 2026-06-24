import sys
import ast
import json

FORBIDDEN_MODULES = {"os", "sys", "subprocess", "importlib", "builtins", "shutil", "socket", "urllib", "requests"}
FORBIDDEN_FUNCTIONS = {"__import__", "eval", "exec", "open", "compile", "globals", "locals"}

class SecurityVisitor(ast.NodeVisitor):
    def __init__(self):
        self.errors = []

    def visit_Import(self, node):
        for alias in node.names:
            base_module = alias.name.split('.')[0]
            if base_module in FORBIDDEN_MODULES:
                self.errors.append(f"Forbidden module import: {alias.name}")
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module:
            base_module = node.module.split('.')[0]
            if base_module in FORBIDDEN_MODULES:
                self.errors.append(f"Forbidden module import: {node.module}")
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_FUNCTIONS:
                self.errors.append(f"Forbidden function call: {node.func.id}")
        self.generic_visit(node)

def validate_script(script: str) -> dict:
    try:
        tree = ast.parse(script)
    except SyntaxError as e:
        return {"status": "error", "message": f"Syntax Error: {e.msg} at line {e.lineno}"}
    except Exception as e:
        return {"status": "error", "message": f"Parse Error: {str(e)}"}

    visitor = SecurityVisitor()
    visitor.visit(tree)

    if visitor.errors:
        return {"status": "error", "message": "AST Validation Failed", "errors": visitor.errors}

    return {"status": "success"}

if __name__ == "__main__":
    try:
        input_data = sys.stdin.read()
        payload = json.loads(input_data)
        script = payload.get("script", "")
        
        result = validate_script(script)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Validator Crash: {str(e)}"}))
