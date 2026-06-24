import { Fragment, useState, useRef, type ChangeEvent, type DragEvent } from 'react';
import Papa from 'papaparse';
import { UploadCloud, CheckCircle2, FileSpreadsheet, BoxSelect, Cpu, Play, ChevronRight, LayoutGrid, FileJson, FileCode2 } from 'lucide-react';
import { ViewState } from '../App';
import { FigureSpec } from '../types';

export function DataImportPage({ onNavigate, spec, onSpecChange }: { onNavigate: (view: ViewState) => void, spec: FigureSpec, onSpecChange: (spec: FigureSpec) => void }) {
  const [step, setStep] = useState(1);

  const [chartType, setChartType] = useState(
    spec.plot_type === 'custom'
      ? '自定义脚本'
      : spec.plot_type === 'scatter_fit'
        ? '散点拟合图'
        : spec.plot_type === 'ranked_response'
          ? '排序响应图'
          : '分组柱状图',
  );
  const [customScript, setCustomScript] = useState(spec.custom_script || "");
  const [dragOver, setDragOver] = useState(false);
  const getAiPrompt = () => `## SciFigure 平台 — Matplotlib 脚本规范

你正在帮助用户编写 Matplotlib 脚本，该脚本将在 SciFigure 平台的 **运行时内省引擎** 上执行。平台原样运行脚本，通过内省 matplotlib artist 树自动识别可编辑图元。

---

### 1. 环境与数据

**运行环境：**
- Python 3.x，matplotlib（Agg 后端）、numpy、pandas、scipy
- 中文字体：Microsoft YaHei、SimHei、Noto Sans SC、Times New Roman

**数据传入（必读）：**
- 上传的数据已解析为 \`_uploaded_data\` 变量，类型为 **list[dict]**（每行一个 dict，key 为列名）
- 用 \`df = pd.DataFrame(_uploaded_data)\` 加载，**不要用 pd.read_csv() / pd.read_excel()**

**输出捕获：**
- 脚本执行后平台自动通过 \`plt.gcf()\` 获取当前 Figure
- **脚本末尾应确保 \`plt.gcf()\` 能拿到 Figure 对象**（用 \`fig, ax = plt.subplots()\` 模式）
- 无需调用 \`plt.savefig()\` 或 \`plt.show()\`

### 2. 平台可识别图元（内省清单）

脚本生成的 Figure 中以下图元会被平台自动识别为可交互编辑对象：

| 图元 | gid 格式 | 可编辑属性 |
|---|---|---|
| 标题 | \`title.{ax_idx}\` | text, fontsize, fontfamily, color |
| X 轴标签 | \`xlabel.{ax_idx}\` | text, fontsize, fontfamily, color |
| Y 轴标签 | \`ylabel.{ax_idx}\` | text, fontsize, fontfamily, color |
| X 轴刻度标签 | \`xtick.{ax_idx}.{i}\` | text, fontsize, fontfamily, color |
| Y 轴刻度标签 | \`ytick.{ax_idx}.{i}\` | text, fontsize, fontfamily, color |
| 脊柱（四边） | \`spine.{side}.{ax_idx}\` | visible, color, linewidth |
| 折线 | \`line.{ax_idx}.{i}\` | color, linewidth, linestyle, alpha |
| 散点/填充集 | \`collection.{ax_idx}.{i}\` | facecolor, edgecolor, alpha |
| 图例 | \`legend.{ax_idx}\` | visible, fontsize |

**推荐的代码模式：**
\`\`\`python
import matplotlib.pyplot as plt
import pandas as pd

df = pd.DataFrame(_uploaded_data)
fig, ax = plt.subplots(figsize=(8, 5))

ax.bar(df['x'], df['y'], color='#1F78B4')
ax.set_title('图表标题', fontsize=14, fontfamily='sans-serif')
ax.set_xlabel('X 轴', fontsize=12)
ax.set_ylabel('Y 轴', fontsize=12)
\`\`\`

### 3. 样式约定（建议遵循）

- **配色：** 推荐使用 #1F78B4（蓝色）表示 promoted、#D62728（红色）表示 suppressed
- **背景：** 白色背景，不添加网格线
- **边框：** 四边 spine 全显示（left + bottom + top + right），默认 matplotlib 全框即可
- **字体：** 默认 sans-serif，中文需指定支持 CJK 的字体
- **标题位置：** 默认居中（\`loc='center'\`）

### 4. 安全性限制（以下操作会被拦截）

- ✗ 读写本地文件（open、pd.read_csv、pickle.load 等）
- ✗ sys.exit()、os.system、subprocess
- ✗ import 未预装包
- ✗ eval()、exec()、\_\_import\_\_
- ✗ 网络请求

### 5. 输出要求

- 只返回纯 Python 代码，**不要用 \`\`\` 包裹**
- 不要添加任何说明文字或注释
- 确保代码没有语法错误，可直接在平台后端的 exec() 中运行
- **注意**：set_xticks/set_xticklabels、set_yticks/set_yticklabels 的数量必须严格一致

---

### 本次任务

数据集列名：${JSON.stringify(headers)}
${(() => {
  if (!allData.length) return '';
  const numericCols: string[] = [];
  const stringCols: string[] = [];
  for (const f of headers) {
    const vals = allData.slice(0, 100).map((r: any) => r[f]);
    const nums = vals.filter((v: any) => !isNaN(parseFloat(v)) && v !== null && v !== '');
    if (nums.length > vals.length * 0.5) numericCols.push(f);
    else stringCols.push(f);
  }
  const statsLines: string[] = [];
  for (const col of numericCols) {
    const vals = allData.map((r: any) => parseFloat(r[col])).filter((v: number) => !isNaN(v));
    if (vals.length === 0) continue;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const avg = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
    const zeroCount = vals.filter((v: number) => v === 0).length;
    statsLines.push(`  ${col}: 范围 [${min}, ${max}], 均值 ${avg.toFixed(2)}, ${vals.length} 个非空值` + (zeroCount > 0 ? `, 含 ${zeroCount} 个零值` : ''));
  }
  return `数据预览（前 5 行）：
${previewData.map((r: any) => JSON.stringify(headers.map(h => ({ [h]: r[h] })))).join('\n')}

数值列统计：
${statsLines.length ? statsLines.join('\n') : '无数值列'}

文本列：${stringCols.join(', ')}
数值列：${numericCols.join(', ')}`;
})()}

用户原始脚本见下方。请改写它：
1. 使用 \`_uploaded_data\` 变量替代文件读取
2. 列名与上述列名匹配
3. 保留绘图意图（配色、标题、统计逻辑）
4. 确保生成的 Figure 可被内省引擎完整识别
5. 根据数据预览和统计信息，**检查并修正**用户脚本中与实际数据不匹配的地方（如列名拼写、零值权重、缺失值处理等）`;

  const [aiResult, setAiResult] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [allData, setAllData] = useState<any[]>([]);
  const [xField, setXField] = useState('');
  const [yField, setYField] = useState('');
  const [groupField, setGroupField] = useState('');
  const [errField, setErrField] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseFile = (uploadedFile: File) => {
    setFile(uploadedFile);
    if (uploadedFile.name.endsWith('.xlsx') || uploadedFile.name.endsWith('.xls')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result;
        import('xlsx').then((XLSX) => {
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const json = XLSX.utils.sheet_to_json(worksheet);
          const fields = json.length > 0 ? Object.keys(json[0] as object) : [];
          setHeaders(fields);
          setPreviewData(json.slice(0, 5));
          setAllData(json as any[]);
          // Auto-map fields
          const numericFields: string[] = [];
          const stringFields: string[] = [];
          for (const f of fields) {
            const vals = json.slice(0, 20).map((r: any) => r[f]);
            const nums = vals.filter((v: any) => !isNaN(parseFloat(v)) && v !== null && v !== '');
            if (nums.length > vals.length * 0.6) numericFields.push(f);
            else stringFields.push(f);
          }
          if (stringFields.length > 0) { setXField(stringFields[0]); setGroupField(''); }
          if (numericFields.length > 0) { setYField(numericFields[0]); setErrField(numericFields.length > 1 ? numericFields[1] : ''); }
        });
      };
      reader.readAsArrayBuffer(uploadedFile);
    } else {
      Papa.parse(uploadedFile, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: (results) => {
        const fields = results.meta.fields && results.meta.fields.length > 0
          ? results.meta.fields
          : Object.keys(results.data[0] as object);
        setHeaders(fields);
        setPreviewData(results.data.slice(0, 5));
        setAllData(results.data as any[]);
        // Auto-map fields
        const numericFields: string[] = [];
        const stringFields: string[] = [];
        for (const f of fields) {
          const vals = results.data.slice(0, 20).map((r: any) => r[f]);
          const nums = vals.filter((v: any) => !isNaN(parseFloat(v)) && v !== null && v !== '');
          if (nums.length > vals.length * 0.6) numericFields.push(f);
          else stringFields.push(f);
        }
        if (stringFields.length > 0) { setXField(stringFields[0]); setGroupField(''); }
        if (numericFields.length > 0) { setYField(numericFields[0]); setErrField(numericFields.length > 1 ? numericFields[1] : ''); }
      }
    });
  }
};

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (uploadedFile) parseFile(uploadedFile);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) parseFile(droppedFile);
  };

  const buildRawData = () => {
    if (!allData.length || !xField || !yField) return;
    const groups: Record<string, { values: number[]; errors?: number[] }> = {};
    const catSet = new Set<string>();
    const rows: { cat: string; grp: string; val: number; err?: number }[] = [];

    for (const row of allData) {
      const cat = String(row[xField] ?? '');
      const val = parseFloat(row[yField]);
      if (!cat || isNaN(val)) continue;
      const grp = groupField ? String(row[groupField] ?? 'Default') : 'Default';
      const err = errField ? parseFloat(row[errField]) : undefined;
      catSet.add(cat);
      rows.push({ cat, grp, val, err });
    }

      const colors = { ...spec.colors };
    const defaultPalette = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
    const sourceMeta = file ? {
      file_name: file.name,
      file_type: file.name.split('.').pop()?.toUpperCase() || 'UNKNOWN',
      row_count: allData.length,
      column_count: headers.length,
      columns: headers,
      imported_at: new Date().toISOString(),
    } : undefined;

    if (chartType === '散点拟合图') {
      const scatter: Record<string, { x: number[], y: number[] }> = {};
      const uniqueGroups = new Set(rows.map(r => r.grp));
      for (const g of uniqueGroups) {
        scatter[g] = { x: [], y: [] };
      }
      for (const row of rows) {
        const xVal = parseFloat(row.cat);
        if (!isNaN(xVal)) {
          scatter[row.grp].x.push(xVal);
          scatter[row.grp].y.push(row.val);
        }
      }
      Object.keys(scatter).forEach((g, i) => {
        if (!colors[g]) colors[g] = defaultPalette[i % defaultPalette.length];
      });
      onSpecChange({ ...spec, plot_type: 'scatter_fit', raw_data: { scatter }, colors, source: sourceMeta });
    } else if (chartType === '排序响应图') {
      const items = rows
        .map(row => ({
          label: row.cat,
          value: row.val,
          group: groupField
            ? row.grp
            : row.val > 0
              ? 'Promoted'
              : 'Suppressed',
        }))
        .sort((a, b) => a.value - b.value);

        const nextColors: Record<string, string> = {
          Promoted: colors.Promoted || '#1F78B4',
          Suppressed: colors.Suppressed || '#D62728',
        };

      items.forEach((item, index) => {
        if (!nextColors[item.group]) {
          nextColors[item.group] = defaultPalette[index % defaultPalette.length];
        }
      });

      onSpecChange({
        ...spec,
        plot_type: 'ranked_response',
        axes: {
          ...spec.axes,
          title: spec.axes.title === 'Relative abundance of ARGs' ? `${yField} ranked response` : spec.axes.title,
          xlabel: spec.axes.xlabel === 'Sample' ? yField : spec.axes.xlabel,
          ylabel: spec.axes.ylabel === 'Relative abundance (%)' ? xField : spec.axes.ylabel,
        },
        raw_data: { ranked_response: { items } },
        colors: nextColors,
        custom_script: customScript,
        source: sourceMeta,
      });
    } else {
      const categories = Array.from(catSet);
      for (const row of rows) {
        if (!groups[row.grp]) groups[row.grp] = { values: [] };
      }
      // Initialize all arrays
      for (const grp of Object.keys(groups)) {
        groups[grp] = { values: new Array(categories.length).fill(0), errors: errField ? new Array(categories.length).fill(0) : undefined };
      }
      // Accumulate values
      const counts: Record<string, number[]> = {};
      for (const grp of Object.keys(groups)) counts[grp] = new Array(categories.length).fill(0);
      for (const row of rows) {
        const ci = categories.indexOf(row.cat);
        const grpArr = groups[row.grp];
        if (grpArr && ci >= 0) {
          grpArr.values[ci] += row.val;
          counts[row.grp][ci]++;
          if (row.err != null && grpArr.errors) grpArr.errors[ci] += row.err * row.err;
        }
      }
      // Average and compute std error
      for (const grp of Object.keys(groups)) {
        for (let i = 0; i < categories.length; i++) {
          const c = counts[grp][i];
          if (c > 0) {
            groups[grp].values[i] /= c;
            if (groups[grp].errors) groups[grp].errors[i] = Math.sqrt(groups[grp].errors![i]) / c;
          }
        }
      }
      Object.keys(groups).forEach((g, i) => {
        if (!colors[g]) colors[g] = defaultPalette[i % defaultPalette.length];
      });
      onSpecChange({ ...spec, plot_type: 'bar', raw_data: { categories, groups }, colors, custom_script: customScript, source: sourceMeta });
    }
  };

  const handleApplyCustomScript = () => {
    onSpecChange({
      ...spec,
      plot_type: 'custom',
      custom_script: customScript,
      raw_data: { custom_data: allData },
      source: file ? {
        file_name: file.name,
        file_type: file.name.split('.').pop()?.toUpperCase() || 'UNKNOWN',
        row_count: allData.length,
        column_count: headers.length,
        columns: headers,
        imported_at: new Date().toISOString(),
      } : spec.source,
    });
    onNavigate('editor');
  };

  const copyPrompt = () => {
    const fullPrompt = getAiPrompt() + '\n\n用户原始脚本:\n' + customScript;
    navigator.clipboard.writeText(fullPrompt).then(() => {
      alert('✅ 提示词 + 脚本已复制到剪贴板！\n\n粘贴到 ChatGPT / DeepSeek / Gemini 等 AI，将改写结果复制回来粘贴到下方。');
    }).catch(() => {
      // Fallback: select all text in the prompt display
      const ta = document.getElementById('ai-prompt-display') as HTMLTextAreaElement;
      if (ta) { ta.select(); document.execCommand('copy'); }
    });
  };

  const handleAiResultPaste = () => {
    if (!aiResult.trim()) {
      alert('请先粘贴 AI 改写后的代码');
      return;
    }
    setCustomScript(aiResult);
    onSpecChange({ 
      ...spec, 
      plot_type: 'custom', 
      custom_script: aiResult, 
      raw_data: { custom_data: allData },
      source: file ? {
        file_name: file.name,
        file_type: file.name.split('.').pop()?.toUpperCase() || 'UNKNOWN',
        row_count: allData.length,
        column_count: headers.length,
        columns: headers,
        imported_at: new Date().toISOString(),
      } : spec.source,
    });
    onNavigate('editor');
  };

  const steps = [
    { num: 1, label: '上传数据' },
    { num: 2, label: '字段映射' },
    { num: 3, label: '配置图形' },
    { num: 4, label: 'AI 生成' }
  ];

  return (
    <div className="flex-1 flex flex-col bg-slate-50 min-w-0 overflow-y-auto">
      {/* Progress Bar */}
      <div className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-center shrink-0">
        <div className="flex items-center w-full max-w-4xl">
          {steps.map((s, i) => (
            <Fragment key={s.num}>
              <div className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shadow-sm transition-colors ${step >= s.num ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border border-slate-300 text-slate-400'}`}>
                  {step > s.num ? <CheckCircle2 className="w-5 h-5 text-white" /> : s.num}
                </div>
                <span className={`text-sm font-medium transition-colors ${step >= s.num ? 'text-slate-800' : 'text-slate-400'}`}>{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`flex-1 h-px mx-4 transition-colors ${step > s.num ? 'bg-blue-600' : 'bg-slate-200'}`}></div>
              )}
            </Fragment>
          ))}
        </div>
      </div>

      <div className="flex-1 max-w-7xl mx-auto w-full p-8 flex gap-8">
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col gap-6">
          <section className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2"><UploadCloud className="w-5 h-5 text-blue-600"/> 数据源上传</h2>
            <div 
              className={`border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center transition-colors cursor-pointer group ${isDragOver ? 'border-blue-500 bg-blue-50 scale-[1.02]' : 'border-slate-300 bg-slate-50 hover:bg-slate-100 hover:border-blue-400'}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input 
                type="file" 
                accept=".csv,.tsv,.txt,.xlsx,.xls" 
                className="hidden" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
              />
              <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <FileSpreadsheet className="w-8 h-8" />
              </div>
              <div className="font-medium text-slate-700 text-lg mb-1">{isDragOver ? '释放文件以导入' : '拖拽或点击上传数据文件'}</div>
              <div className="text-sm text-slate-500 mb-4">{isDragOver ? '' : '支持 CSV, TSV, TXT, XLSX。最大 50MB'}</div>
              {file && (
                <div className="flex gap-2">
                  <span className="px-3 py-1 bg-white border border-slate-200 rounded text-xs font-mono text-slate-600 shadow-sm">{file.name} (已上传)</span>
                </div>
              )}
            </div>
            {step === 1 && (
              <div className="mt-4 flex justify-end">
                <button 
                  onClick={() => { if (file && headers.length > 0) setStep(2); }}
                  disabled={!file || headers.length === 0}
                  className={`px-6 py-2 rounded-md font-medium shadow-sm transition-colors ${
                    file && headers.length > 0 
                      ? 'bg-blue-600 text-white hover:bg-blue-700' 
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >下一步: 映射 {file && headers.length > 0 ? '' : '(请先上传文件)'}</button>
              </div>
            )}
          </section>

          {step >= 2 && (
            <section className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
              <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2"><BoxSelect className="w-5 h-5 text-purple-600"/> 字段映射</h2>
              <div className="grid grid-cols-2 gap-6 mb-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-slate-50">
                    <span className="font-semibold text-slate-700 text-sm">X 轴 (分类)</span>
                    <select value={xField} onChange={e => setXField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                      {headers.length > 0 ? headers.map(h => <option key={h}>{h}</option>) : <option>无数据</option>}
                    </select>
                  </div>
                  <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-slate-50">
                    <span className="font-semibold text-slate-700 text-sm">Y 轴 (数值)</span>
                    <select value={yField} onChange={e => setYField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                      {headers.length > 0 ? headers.map(h => <option key={h}>{h}</option>) : <option>无数据</option>}
                    </select>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-slate-50">
                    <span className="font-semibold text-slate-700 text-sm">分组 (Group)</span>
                    <select value={groupField} onChange={e => setGroupField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                      <option value="">无分组</option>
                      {headers.length > 0 ? headers.map(h => <option key={h}>{h}</option>) : null}
                    </select>
                  </div>
                  <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-slate-50">
                    <span className="font-semibold text-slate-700 text-sm">误差棒 (Err)</span>
                    <select value={errField} onChange={e => setErrField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                      <option value="">无</option>
                      {headers.length > 0 ? headers.map(h => <option key={h}>{h}</option>) : null}
                    </select>
                  </div>
                </div>
              </div>
              
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-slate-100 px-4 py-2 border-b border-slate-200 text-xs font-semibold text-slate-600 flex justify-between">
                  <span>数据预览 (前 5 行)</span>
                  <span className="text-slate-400">{file ? `已加载` : `等待上传`}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left whitespace-nowrap">
                    <thead className="bg-slate-50 border-b border-slate-200 font-mono text-xs text-slate-500">
                      <tr>
                        {headers.map((h, i) => <th key={i} className="px-4 py-2">{h}</th>)}
                        {headers.length === 0 && <th className="px-4 py-2">请先上传文件</th>}
                      </tr>
                    </thead>
                    <tbody className="font-mono text-slate-800">
                      {previewData.map((row, i) => (
                        <tr key={i} className="border-b border-slate-100">
                          {headers.map((h, j) => (
                            <td key={j} className="px-4 py-2">{row[h] !== undefined ? String(row[h]) : ''}</td>
                          ))}
                        </tr>
                      ))}
                      {previewData.length > 0 && (
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                          {headers.map((h, j) => <td key={j} className="px-4 py-2 text-slate-400">...</td>)}
                        </tr>
                      )}
                      {previewData.length === 0 && (
                        <tr><td className="px-4 py-2 text-slate-400">暂无数据</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 text-xs text-slate-500">
                  共 {allData.length} 行数据，{headers.length} 列字段
                </div>
              </div>

              {step === 2 && (
                <div className="mt-6 flex justify-end">
                  <button 
                    onClick={() => { 
                      if (!xField || !yField) { alert('请先选择 X 轴和 Y 轴字段'); return; }
                      buildRawData(); 
                      setStep(3); 
                    }} 
                    className="px-6 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 shadow-sm transition-colors"
                  >下一步: AI 配置</button>
                </div>
              )}
            </section>
          )}

          {step >= 3 && (
            <section className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
              <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2"><Cpu className="w-5 h-5 text-indigo-600"/> AI 绘图参数生成</h2>
              
              <div className="mb-4">
                <label className="block text-sm font-semibold text-slate-700 mb-2">图形类型</label>
                <div className="grid grid-cols-4 gap-3">
                   {[
                     { label: '分组柱状图', supported: true },
                     { label: '散点拟合图', supported: true },
                     { label: '排序响应图', supported: true },
                     { label: '自定义脚本', supported: true },
                    ].map(({ label: t, supported: s }) => (
                       <div key={t} onClick={() => { s && setChartType(t); if (t === '自定义脚本' && chartType !== '自定义脚本') { setCustomScript(''); setAiResult(''); } }} className={`p-3 border rounded-lg text-center cursor-pointer transition-colors ${chartType === t ? 'border-blue-600 bg-blue-50 text-blue-700 font-medium shadow-sm' : s ? 'border-slate-200 hover:border-blue-300 text-slate-600' : 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed'}`}>
                         {t === '自定义脚本' ? <FileCode2 className={`w-5 h-5 mx-auto mb-1 ${chartType === t ? 'text-blue-600':'text-slate-400'}`} /> : <LayoutGrid className={`w-5 h-5 mx-auto mb-1 ${chartType === t ? 'text-blue-600':'text-slate-400'}`} />}
                         <span className="text-xs">{t}</span>
                      </div>
                    ))}
                    {/* Placeholder for future chart types */}
                    <div className="p-3 border border-dashed border-slate-200 rounded-lg text-center text-slate-300 text-xs flex flex-col items-center justify-center cursor-default">
                      <span className="text-[10px]">更多类型</span>
                      <span className="text-[8px]">开发中</span>
                    </div>
                </div>
                {chartType === '自定义脚本' && (
                  <div className="mt-4">
                    <label className="block text-sm font-semibold text-slate-700 mb-2">粘贴或编写您的 Python 绘图脚本</label>
                    <div
                      className="relative"
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const file = e.dataTransfer.files?.[0];
                        if (!file || !file.name.endsWith('.py')) return;
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                          setCustomScript(ev.target?.result as string || '');
                        };
                        reader.readAsText(file);
                      }}
                    >
                      {dragOver && (
                        <div className="absolute inset-0 z-10 bg-blue-500/20 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
                          <span className="text-blue-700 font-semibold text-lg bg-white/80 px-4 py-2 rounded shadow">松开以上传 .py 文件</span>
                        </div>
                      )}
                      <textarea 
                        className="w-full h-48 p-3 text-sm font-mono bg-slate-900 text-green-400 rounded-lg border border-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                        placeholder="# 平台通过 plt.gcf() 捕获 Figure，无需 savefig/show\nimport matplotlib.pyplot as plt\nimport pandas as pd\nimport numpy as np\n\n# 数据在 _uploaded_data (list[dict]) 中\n# df = pd.DataFrame(_uploaded_data)\n\nfig, ax = plt.subplots()\n# 您的代码..."
                        value={customScript}
                        onChange={(e) => setCustomScript(e.target.value)}
                      />
                      <div className="absolute bottom-4 right-4 flex items-center gap-2">
                        <input
                          type="file"
                          accept=".py"
                          className="hidden"
                          id="py-upload-dataimport"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                              setCustomScript(ev.target?.result as string || '');
                            };
                            reader.readAsText(file);
                            e.target.value = '';
                          }}
                        />
                        <label
                          htmlFor="py-upload-dataimport"
                          className="bg-slate-600 hover:bg-slate-500 text-white px-3 py-2 rounded shadow text-sm font-medium transition-colors cursor-pointer"
                        >
                          上传 .py 文件
                        </label>
                        <button 
                          className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded shadow text-sm font-medium transition-colors"
                          onClick={handleApplyCustomScript}
                        >
                          直接应用代码
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {chartType === '自定义脚本' && (
                  <div className="mt-6 border-t border-slate-200 pt-6">
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-sm font-semibold text-slate-700">🤖 AI 改写（拷贝到网页 AI → 粘贴回来）</label>
                    </div>

                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 text-sm text-amber-800 leading-relaxed">
                      <p className="font-semibold mb-1">操作步骤：</p>
                      <ol className="list-decimal list-inside space-y-1 text-amber-700">
                        <li>点击下方按钮 <strong>「复制提示词 + 脚本」</strong></li>
                        <li>打开 ChatGPT / DeepSeek / Gemini 等网页 AI</li>
                        <li>粘贴到对话框，让 AI 改写</li>
                        <li>把 AI 返回的代码 <strong>复制回来</strong> 粘贴到下方输入框</li>
                        <li>点击 <strong>「应用 AI 结果并打开编辑器」</strong></li>
                      </ol>
                    </div>

                    <textarea id="ai-prompt-display" readOnly rows={4}
                      className="w-full mb-3 p-3 text-xs font-mono bg-slate-100 text-slate-600 rounded-lg border border-slate-200 outline-none resize-none"
                      value={getAiPrompt() + '\n\n用户原始脚本:\n' + customScript}
                    />

                    <div className="flex gap-2 mb-4">
                      <button onClick={copyPrompt}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 shadow-sm transition-colors"
                      >
                        📋 复制提示词 + 脚本
                      </button>
                    </div>

                    <label className="block text-sm font-semibold text-slate-700 mb-1.5">粘贴 AI 改写结果</label>
                    <textarea 
                      className="w-full h-32 p-3 text-sm font-mono bg-white text-slate-800 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                      placeholder="将 AI 返回的代码粘贴到这里..."
                      value={aiResult}
                      onChange={(e) => setAiResult(e.target.value)}
                    />
                    <div className="mt-2 flex justify-end">
                      <button 
                        className="px-5 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white rounded-lg text-sm font-bold shadow-sm transition-all flex items-center gap-2"
                        onClick={handleAiResultPaste}
                      >
                        ✨ 应用 AI 结果并打开编辑器
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {step === 3 && (
                <div className="mt-6 flex justify-end gap-3">
                  <button onClick={() => { 
                    if (chartType !== '自定义脚本') {
                      if (!xField || !yField) { alert('请选择 X 轴和 Y 轴字段'); return; }
                      buildRawData(); 
                    }
                    setStep(4); 
                  }} className="px-6 py-2 bg-indigo-600 text-white rounded-md font-medium hover:bg-indigo-700 shadow flex items-center gap-2 transition-colors">
                    <Cpu className="w-4 h-4" /> 生成 Figure Spec
                  </button>
                </div>
              )}
            </section>
          )}

        </div>

        {/* Right Sidebar - Preview & Review */}
        <div className="w-80 shrink-0">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm sticky top-8">
            <h2 className="font-bold text-slate-800 mb-4 flex items-center justify-between">
              图形草稿
              {step >= 4 && <span className="bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded font-medium border border-emerald-200">生成成功</span>}
            </h2>
            
            <div className={`w-full aspect-[4/3] rounded-lg border-2 border-dashed flex flex-col items-center justify-center mb-6 transition-all duration-500 ${step >= 4 ? 'border-indigo-200 bg-indigo-50/50' : 'bg-slate-50 border-slate-200'}`}>
               {step >= 4 ? (
                  <div className="text-center p-4">
                    <FileJson className="w-10 h-10 text-indigo-500 mx-auto mb-2" />
                    <div className="text-sm font-semibold text-indigo-800">figure_spec.json</div>
                    <div className="text-xs text-indigo-600/70 mt-1">已捕获所有图形参数映射</div>
                  </div>
               ) : (
                 <span className="text-slate-400 text-sm">等待配置...</span>
               )}
            </div>

            {step >= 4 && (
              <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="bg-blue-50 text-blue-800 text-sm p-4 rounded-lg border border-blue-100 shadow-sm leading-relaxed">
                  <p className="font-semibold mb-1 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4"/> AI 分析报告</p>
                  <p className="text-blue-700/80 mb-2">已成功将你的数据和提示词转换为标准化科研绘图属性。建议在下一步中手动微调配色和标签位置。</p>
                </div>

                <div className="pt-2 border-t border-slate-100">
                  <button onClick={() => { onNavigate('editor'); }} className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium shadow-md hover:bg-blue-700 flex items-center justify-center gap-2 transition-all hover:scale-[1.02]">
                    <Play className="w-4 h-4" /> 在编辑器中打开并渲染
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
