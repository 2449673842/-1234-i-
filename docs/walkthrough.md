# Walkthrough: SciFigure IFC V3.2A — Project Layer Implementation

This walkthrough details the complete implementation and verification of **V3.2 Phase A (Project Layer)**. We have successfully upgraded SciFigure from a single-figure editor into a multi-file, multi-figure scientific project workspace.

---

## 1. Project Layer Deliverables

We have fully implemented all planned features under V3.2A:

### 1.1 Database Schema Extensions (`db.ts`)
- **`projects` table**: Added `script` and `file_count` columns.
- **`project_files` table**: Added schema for project datasets containing `datasetId`, `fileName`, `filePath`, `columns` (JSON), and `rowCount`.
- **`project_figures` table**: Keeps track of multiple generated figure instances associated with a project.
- **Cascade Deletions**: Configured `ON DELETE CASCADE` constraints on sqlite foreign keys so deleting a project instantly cleans up files and figures database registries.

### 1.2 Multi-File Upload & Management APIs (`server.ts`)
- Configured multer disk storage under `data/projects/:id/files/`.
- **`POST /api/projects/:id/files`**: Handles uploads of CSV, TSV, and XLSX. It parses columns/headers, counts data rows using Node-side parsing, and registers them in the database.
- **`GET /api/projects/:id/files`**: Returns a list of uploaded datasets.
- **`DELETE /api/projects/:id/files/:fileId`**: Deletes both database records and physical files on disk.
- **Cascade Physical Cleanup**: Implemented synchronous directory deletion on process level when deleting projects.

### 1.3 Matplotlib Multi-Figure Capture (`renderer/introspector.py`)
- **Monkeypatch Figure Creation**: Intercepts `Figure.__init__` to record all figure instances in a runtime `_figure_registry`.
- **Closed Figures Backup**: Combines runtime hooks with a post-execution `plt.get_fignums()` scan, ensuring figures are preserved and introspected even if the script calls `plt.close(fig)`.
- **Text Artist Manifest Extensions**: Extended properties scanned on text elements to include coordinates and styles (`x`, `y`, `coord_system`, `ha`, `va`, `rotation`) for future text dragging functionality.

### 1.4 Path Sandboxing & CWD Relative Resolution (`renderer/introspector.py`)
- **Working Directory Jail**: Temporarily changes the Python process working directory (`os.chdir`) to the project files directory during execution.
- **Security Check Hooks**: Patches `pd.read_csv` and `pd.read_excel` to resolve paths via `os.path.realpath` and block access to any directory outside the project folder.
- **Transparent Path Translation**: Intercepts relative file reads (e.g., `pd.read_csv("summary.csv")`) and dynamically maps them to their timestamped physical stored paths using `_uploaded_file_paths` variables.

### 1.5 Multi-Figure UI & Independent States (`src/` components)
- **Figure Tabs UI**: Rendered dynamic tab controls (`Figure 1`, `Figure 2`, etc.) in `MainWorkspace.tsx` representing Matplotlib figure instances.
- **Workspace State Segmentation**: Dynamically switches the active figure context. Each tab manages its own SVG preview, edit log histories, and local/backend patches.
- **Project Files Registry UI**: Left sidebar renders uploaded datasets with file types and action buttons to delete files or upload new ones.

---

## 2. Automated Validation Results

We performed automated testing at both Python and API route levels to verify correctness:

### 2.1 Python Introspector Integration Tests (`scratch/test_introspector_v32.py`)
Tests verified sandbox directory jails, relative path translations, and closed figure capturing:
```text
=== STARTING V3.2A BACKEND INTEGRATION TESTS ===

--- Running Test 1: Successful Multi-Figure Introspection with Sandboxed Reads ---
[SUCCESS] Rendering and introspection succeeded.
[INFO] Captured 2 figures (expected 2).
  - Figure 1 ID: fig_1, SVG Length: 10442 chars
    Title object label: title.0
    Current properties: {'text': 'Figure 1 Title', ...}
  - Figure 2 ID: fig_2, SVG Length: 9073 chars
    Title object label: title.0
    Current properties: {'text': 'Figure 2 Title', ...}
[PASS] Test 1: Successful Multi-Figure Introspection Passed.

--- Running Test 2: Sandboxed Path Traversal Security Verification ---
[PASS] Successfully blocked absolute path traversal outside sandbox.
[PASS] Successfully blocked relative path traversal outside sandbox.

=== ALL BACKEND TESTS PASSED SUCCESSFULLY ===
```

### 2.2 Endpoint Integration Tests (`scratch/test_projects_v32.js`)
Tests executed end-to-end Project APIs with a running production server:
```text
=== STARTING V3.2A PROJECT ENDPOINTS INTEGRATION TESTS ===

1. Calling POST /api/projects...
[PASS] Created project with ID: 0a28e9d6-a595-419a-bf69-5fe41291abdf

2. Calling POST /api/projects/:id/files...
[PASS] Uploaded file financial.csv, registered File ID: 4db5f3fe-6d05-4db2-b11d-d6a1f715de5a
Columns: ["year","profit","loss"] (Expected: ["year","profit","loss"])
RowCount: 3 (Expected: 3)

3. Calling GET /api/projects/:id/files...
[PASS] Found 1 files in registry.

4. Calling POST /api/projects/:id/figures/render...
[PASS] Rendered successfully. Captured 2 figures.
- Fig 1 ID: fig_1, SVG has title: true
- Fig 2 ID: fig_2, SVG has title: true

5. Calling GET /api/projects/:id/figures...
[PASS] Figures metadata returned 2 entries.

6. Calling POST /api/projects/:id/export...
[PASS] Exported 2 figures as PNG.
- Fig 1 format: png, base64 length: 45840

7. Calling DELETE /api/projects/:id...
[PASS] Project deleted successfully.
Project files after deletion count: 0
[PASS] Cascade database validation check passed.

=== ALL ENDPOINT TESTS PASSED SUCCESSFULLY! ===
```

### 2.3 Compilation and Build Verification
We checked both the frontend and backend build toolchains:
```bash
npm run build
```
**Output**:
```text
vite v6.4.3 building for production...
✓ built in 4.71s
  dist\server.cjs      33.5kb
  dist\server.cjs.map  58.6kb
Done in 8ms
```
The application compiles and bundles successfully without any TypeScript or compilation warnings.

---

## 3. Manual Verification Steps for User

To interactively verify project mode:
1. **Initialize Project**: Go to the Project Explorer, create a new project.
2. **Upload Datasets**: In the left sidebar under **数据管理**, upload one or more CSV/XLSX files.
3. **Write Script**: Paste a multi-figure python script reading your uploaded filenames (e.g., `pd.read_csv("your_filename.csv")` or using the `_uploaded_file_paths["your_filename"]` variable).
4. **Trigger Render**: Click **同步至引擎并预览 SVG**.
5. **Switch Figures**: Observe the new **Figure Tabs** above the preview area. Switch between figures to edit them independently.
6. **Export Project**: Verify exporting individual or all project figures in the export settings panel.
