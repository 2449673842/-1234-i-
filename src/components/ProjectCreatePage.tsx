import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import Papa from 'papaparse';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  ClipboardCopy,
  FileCode2,
  FileDown,
  FileSpreadsheet,
  Play,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  buildTranslationPrompt,
  chooseDefaultFields,
  inferFieldTypes,
  type DataRow,
  type TranslationPromptDataset,
  normalizeValue,
} from '../utils/scriptTranslationContract';

const DEFAULT_TEMPLATE = `import matplotlib.pyplot as plt
import pandas as pd

df = pd.DataFrame(_uploaded_data)

fig, ax = plt.subplots(figsize=(100 / 25.4, 80 / 25.4), dpi=150)

# ==== 在此编写绘图代码 ====
# 例如：
# ax.plot(df["x"], df["y"], marker="o", label="Demo")

ax.set_xlabel("X Axis")
ax.set_ylabel("Y Axis")
ax.set_title("My Plot")
ax.legend()

plt.tight_layout()
`;

interface PendingDataset {
  id: string;
  file: File;
}

interface ParsedDataset {
  headers: string[];
  previewData: DataRow[];
  allData: DataRow[];
  numericFields: string[];
  stringFields: string[];
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

async function parseDatasetFile(file: File): Promise<ParsedDataset> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    const buffer = await readFileAsArrayBuffer(file);
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const json = XLSX.utils.sheet_to_json(worksheet, { defval: null }) as Array<Record<string, unknown>>;
    const headers = json.length > 0 ? Object.keys(json[0]) : [];
    const { numericFields, stringFields } = inferFieldTypes(json, headers);
    return {
      headers,
      previewData: json.slice(0, 5),
      allData: json,
      numericFields,
      stringFields,
    };
  }

  const text = await readFileAsText(file);
  const delimiter = lowerName.endsWith('.tsv') ? '\t' : ',';
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    delimiter,
  });
  const allData = Array.isArray(parsed.data) ? parsed.data : [];
  const headers = parsed.meta.fields && parsed.meta.fields.length > 0
    ? parsed.meta.fields
    : (allData[0] ? Object.keys(allData[0]) : []);
  const { numericFields, stringFields } = inferFieldTypes(allData, headers);

  return {
    headers,
    previewData: allData.slice(0, 5),
    allData,
    numericFields,
    stringFields,
  };
}

export function ProjectCreatePage({ onNavigate, onLoadProject }: {
  onNavigate: (view: string, subView?: string) => void;
  onLoadProject: (id: string, name: string, data: any) => void;
}) {
  const [name, setName] = useState('未命名项目');
  const [script, setScript] = useState(DEFAULT_TEMPLATE);
  const [aiResult, setAiResult] = useState('');
  const [pendingDatasets, setPendingDatasets] = useState<PendingDataset[]>([]);
  const [parsedDatasets, setParsedDatasets] = useState<Record<string, ParsedDataset>>({});
  const [primaryDatasetId, setPrimaryDatasetId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewData, setPreviewData] = useState<Array<Record<string, unknown>>>([]);
  const [allData, setAllData] = useState<Array<Record<string, unknown>>>([]);
  const [numericFields, setNumericFields] = useState<string[]>([]);
  const [stringFields, setStringFields] = useState<string[]>([]);
  const [xField, setXField] = useState('');
  const [yField, setYField] = useState('');
  const [groupField, setGroupField] = useState('');
  const [errField, setErrField] = useState('');
  const [isParsingData, setIsParsingData] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copyLabel, setCopyLabel] = useState('复制 AI 提示词');
  const [scriptDragOver, setScriptDragOver] = useState(false);
  const [dataDragOver, setDataDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dataFileInputRef = useRef<HTMLInputElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const primaryDataset = useMemo(
    () => pendingDatasets.find(item => item.id === primaryDatasetId) || null,
    [pendingDatasets, primaryDatasetId],
  );

  useEffect(() => {
    let cancelled = false;
    if (pendingDatasets.length === 0) {
      setParsedDatasets({});
      setIsParsingData(false);
      return;
    }

    setIsParsingData(true);
    Promise.all(
      pendingDatasets.map(async item => {
        const parsed = await parseDatasetFile(item.file);
        return [item.id, parsed] as const;
      }),
    )
      .then(entries => {
        if (cancelled) return;
        setParsedDatasets(Object.fromEntries(entries));
      })
      .catch(() => {
        if (cancelled) return;
        setParsedDatasets({});
      })
      .finally(() => {
        if (!cancelled) setIsParsingData(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pendingDatasets]);

  useEffect(() => {
    if (!primaryDataset || !parsedDatasets[primaryDataset.id]) {
      setHeaders([]);
      setPreviewData([]);
      setAllData([]);
      setNumericFields([]);
      setStringFields([]);
      setXField('');
      setYField('');
      setGroupField('');
      setErrField('');
      return;
    }

    const parsed = parsedDatasets[primaryDataset.id];
    setHeaders(parsed.headers);
    setPreviewData(parsed.previewData);
    setAllData(parsed.allData);
    setNumericFields(parsed.numericFields);
    setStringFields(parsed.stringFields);
    const defaults = chooseDefaultFields(parsed.headers, parsed.allData, parsed.numericFields, parsed.stringFields);
    setXField(prev => prev && parsed.headers.includes(prev) ? prev : defaults.xField);
    setYField(prev => prev && parsed.headers.includes(prev) ? prev : defaults.yField);
    setGroupField(prev => prev && parsed.headers.includes(prev) ? prev : defaults.groupField);
    setErrField(prev => prev && parsed.headers.includes(prev) ? prev : defaults.errField);
  }, [primaryDataset, parsedDatasets]);

  const hasData = pendingDatasets.length > 0;
  const dataReady = hasData && pendingDatasets.every(item => Boolean(parsedDatasets[item.id])) && headers.length > 0;
  const hasScript = script.trim().length > 0;
  const activeStep = !dataReady ? 1 : !hasScript ? 2 : 3;
  const scriptLineCount = useMemo(() => script.split(/\r?\n/).length, [script]);
  const additionalPromptDatasets = useMemo<TranslationPromptDataset[]>(() => {
    return pendingDatasets
      .filter(item => item.id !== primaryDatasetId)
      .map(item => {
        const parsed = parsedDatasets[item.id];
        if (!parsed) return null;
        const mapping = chooseDefaultFields(parsed.headers, parsed.allData, parsed.numericFields, parsed.stringFields);
        return {
          fileName: item.file.name,
          headers: parsed.headers,
          rows: parsed.allData,
          previewRows: parsed.previewData,
          mapping,
        };
      })
      .filter((item): item is TranslationPromptDataset => Boolean(item));
  }, [pendingDatasets, parsedDatasets, primaryDatasetId]);

  const aiPrompt = useMemo(() => {
    return buildTranslationPrompt({
      headers,
      rows: allData,
      previewRows: previewData,
      primaryDataFileName: primaryDataset?.file.name,
      additionalDatasets: additionalPromptDatasets,
      xField,
      yField,
      groupField,
      errField,
      originalScript: script,
    });
  }, [additionalPromptDatasets, allData, errField, groupField, headers, previewData, primaryDataset, script, xField, yField]);

  const steps = [
    { num: 1, label: '上传数据' },
    { num: 2, label: '准备脚本' },
    { num: 3, label: '创建项目并进入编辑器' },
  ];

  const addPendingFiles = (files: FileList | File[] | null | undefined) => {
    if (!files) return;
    const allowed = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xls']);
    const items = Array.from(files)
      .filter(file => {
        const dotIndex = file.name.lastIndexOf('.');
        const ext = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : '';
        return allowed.has(ext);
      })
      .map(file => ({
        id: `${file.name}_${file.size}_${file.lastModified}`,
        file,
      }));

    setPendingDatasets(prev => {
      const existingIds = new Set(prev.map(item => item.id));
      const deduped = items.filter(item => !existingIds.has(item.id));
      const next = [...prev, ...deduped];
      if (!primaryDatasetId && next.length > 0) {
        setPrimaryDatasetId(next[0].id);
      }
      return next;
    });
  };

  const removePendingFile = (id: string) => {
    setPendingDatasets(prev => {
      const next = prev.filter(item => item.id !== id);
      if (primaryDatasetId === id) {
        setPrimaryDatasetId(next[0]?.id || null);
      }
      return next;
    });
  };

  const setAsPrimaryDataset = (id: string) => {
    setPrimaryDatasetId(id);
  };

  const handleDataFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    addPendingFiles(e.target.files);
    e.target.value = '';
  };

  const handleDataDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDataDragOver(false);
    addPendingFiles(e.dataTransfer.files);
  };

  const handleScriptFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      setScript((ev.target?.result as string) || '');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const readScriptFile = (file: File) => {
    if (!file.name.endsWith('.py')) return;
    const reader = new FileReader();
    reader.onload = ev => {
      setScript((ev.target?.result as string) || '');
    };
    reader.readAsText(file);
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(aiPrompt).then(() => {
      setCopyLabel('已复制 ✓');
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyLabel('复制 AI 提示词'), 2000);
    });
  };

  const applyAiResult = () => {
    if (!aiResult.trim()) {
      alert('请先粘贴 AI 改写后的脚本');
      return;
    }
    setScript(aiResult);
    setAiResult('');
  };

  const handleClear = () => {
    setScript(DEFAULT_TEMPLATE);
  };

  const renderStepStatus = (stepNum: number) => {
    const isComplete =
      (stepNum === 1 && hasData) ||
      (stepNum === 2 && dataReady && hasScript);
    const isCurrent = activeStep === stepNum;

    return (
      <div
        key={stepNum}
        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shadow-sm transition-colors ${
          isComplete || isCurrent
            ? 'bg-blue-600 text-white border-blue-600'
            : 'bg-white border border-slate-300 text-slate-400'
        }`}
      >
        {isComplete ? <CheckCircle2 className="w-5 h-5 text-white" /> : stepNum}
      </div>
    );
  };

  const createProjectAndEnter = async () => {
    if (!name.trim()) {
      alert('请输入项目名称');
      return;
    }
    if (!hasData) {
      alert('请先上传至少一个数据文件');
      return;
    }
    if (!dataReady) {
      alert('数据文件还在解析，请等待所有文件完成解析');
      return;
    }
    if (!hasScript) {
      alert('请先准备可运行的 Python 脚本');
      return;
    }

    setSubmitting(true);
    try {
      const sourceMeta = primaryDataset ? {
        file_name: primaryDataset.file.name,
        file_type: primaryDataset.file.name.split('.').pop()?.toUpperCase() || 'UNKNOWN',
        row_count: allData.length,
        column_count: headers.length,
        columns: headers,
        imported_at: new Date().toISOString(),
      } : undefined;

      const createRes = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          spec: {
            plot_type: 'custom',
            figure: { width: 100, height: 80, unit: 'mm', dpi: 150 },
            colors: {},
            custom_script: script,
            raw_data: { custom_data: allData },
            source: sourceMeta,
            data: {
              x: xField,
              y: yField,
              group: groupField,
            },
          },
        }),
      });
      const createData = await createRes.json();
      if (createData.status !== 'success') {
        throw new Error(createData.message || '创建项目失败');
      }

      const projectId = createData.id as string;
      const orderedDatasets = [
        ...pendingDatasets.filter(item => item.id === primaryDatasetId),
        ...pendingDatasets.filter(item => item.id !== primaryDatasetId),
      ];

      for (const item of orderedDatasets) {
        const formData = new FormData();
        formData.append('file', item.file);
        const uploadRes = await fetch(`/api/projects/${projectId}/files`, {
          method: 'POST',
          body: formData,
        });
        const uploadData = await uploadRes.json();
        if (uploadData.status !== 'success') {
          throw new Error(`上传 ${item.file.name} 失败: ${uploadData.message || '未知错误'}`);
        }
      }

      const updateRes = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          spec: {
            plot_type: 'custom',
            figure: { width: 100, height: 80, unit: 'mm', dpi: 150 },
            colors: {},
            custom_script: script,
            raw_data: { custom_data: allData },
            source: sourceMeta,
            data: {
              x: xField,
              y: yField,
              group: groupField,
            },
          },
        }),
      });
      const updateData = await updateRes.json();
      if (updateData.status !== 'success') {
        throw new Error(updateData.message || '保存脚本失败');
      }

      const getRes = await fetch(`/api/projects/${projectId}`);
      const getData = await getRes.json();
      if (getData.status !== 'success') {
        throw new Error(getData.message || '载入项目失败');
      }

      onLoadProject(projectId, name.trim(), getData.project);
    } catch (err: any) {
      alert(err.message || '创建流程失败');
    } finally {
      setSubmitting(false);
    }
  };

  const rightPanel = (
    <div className="w-80 shrink-0">
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm sticky top-8 space-y-5">
        <div>
          <h2 className="font-bold text-slate-800 mb-1">流程状态</h2>
          <p className="text-sm text-slate-500 leading-6">
            新路径必须补回旧版最关键的东西：真实数据预览、字段识别、以及基于真实列名的脚本改写提示。
          </p>
        </div>

        <div className="space-y-3">
          {[
            ['数据已选择', hasData],
            ['全部数据已解析', dataReady],
            ['脚本已准备', hasScript],
            ['可进入编辑器', hasData && hasScript],
          ].map(([label, done]) => (
            <div key={label} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
              <span className="text-sm font-medium text-slate-700">{label}</span>
              <span className={`text-xs font-semibold px-2 py-1 rounded ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                {done ? '完成' : '待完成'}
              </span>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-800">多数据文件规则</div>
          <p className="text-sm text-slate-600 leading-6">
            带 <span className="font-semibold text-blue-700">主数据</span> 标记的文件会作为 `_uploaded_data` 注入。其他文件会独立识别字段和推荐映射，并通过 `_uploaded_file_paths` 放进提示词和运行时。
          </p>
        </div>

        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <div className="text-sm font-semibold text-blue-800 mb-2">为什么旧版更稳</div>
          <ul className="space-y-2 text-sm text-blue-700 leading-6">
            <li>旧版先解析真实数据，再生成带列名上下文的提示词。</li>
            <li>旧版让你先看到前几行，不会盲目把数值列当文本列。</li>
            <li>现在这个新页也补回了这条路径。</li>
          </ul>
        </div>

        <button
          onClick={() => onNavigate('data_import')}
          className="w-full py-2.5 border border-slate-300 bg-white rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors"
          type="button"
        >
          切换到旧版数据导入流程
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col bg-slate-50 min-w-0 overflow-y-auto">
      <div className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-center shrink-0">
        <div className="flex items-center w-full max-w-5xl">
          {steps.map((step, index) => (
            <div key={step.num} className="flex items-center flex-1">
              <div className="flex items-center gap-2">
                {renderStepStatus(step.num)}
                <span className={`text-sm font-medium transition-colors ${activeStep >= step.num ? 'text-slate-800' : 'text-slate-400'}`}>
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div className={`flex-1 h-px mx-4 transition-colors ${activeStep > step.num ? 'bg-blue-600' : 'bg-slate-200'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 max-w-7xl mx-auto w-full p-8 flex gap-8">
        <div className="flex-1 flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('home')}
              className="p-2 rounded-lg hover:bg-slate-200 transition-colors text-slate-500"
              title="返回首页"
              type="button"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-slate-800">新建图形项目</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                先解析真实数据，再改脚本。不要让 AI 在不知道列名和数据类型的情况下盲改。
              </p>
            </div>
          </div>

          <section className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-4">1. 上传并识别数据文件</h2>
            <div className="grid lg:grid-cols-[1.05fr,0.95fr] gap-6">
              <div
                className={`border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center transition-colors cursor-pointer ${
                  dataDragOver ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'
                }`}
                onClick={() => dataFileInputRef.current?.click()}
                onDragOver={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDataDragOver(true);
                }}
                onDragLeave={() => setDataDragOver(false)}
                onDrop={handleDataDrop}
              >
                <input
                  ref={dataFileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,.xls"
                  multiple
                  className="hidden"
                  onChange={handleDataFileSelect}
                />
                <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-4">
                  <FileSpreadsheet className="w-8 h-8" />
                </div>
                <div className="font-medium text-slate-700 text-lg mb-1">
                  {dataDragOver ? '释放文件以加入本次项目' : '拖拽或点击选择数据文件'}
                </div>
                <div className="text-sm text-slate-500 text-center leading-6">
                  支持 CSV、TSV、TXT、XLSX。每个文件都会独立识别字段，主数据只决定 `_uploaded_data`。
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-700">
                  本次将导入的数据
                </div>
                <div className="p-4 min-h-[220px]">
                  {pendingDatasets.length > 0 ? (
                    <ul className="space-y-3">
                      {pendingDatasets.map(item => {
                        const isPrimary = item.id === primaryDatasetId;
                        const parsed = parsedDatasets[item.id];
                        const inferredMapping = parsed
                          ? chooseDefaultFields(parsed.headers, parsed.allData, parsed.numericFields, parsed.stringFields)
                          : null;
                        return (
                          <li key={item.id} className={`flex items-center gap-3 rounded-lg border px-3 py-3 ${isPrimary ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white'}`}>
                            <FileSpreadsheet className="w-4 h-4 text-emerald-500 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-slate-800 truncate">{item.file.name}</div>
                              <div className="text-xs text-slate-500 flex flex-wrap gap-x-2 gap-y-1">
                                <span>{(item.file.size / 1024).toFixed(1)} KB</span>
                                {parsed ? (
                                  <>
                                    <span>{parsed.allData.length} 行</span>
                                    <span>{parsed.headers.length} 列</span>
                                    {!isPrimary && inferredMapping && (
                                      <span className="text-blue-600">
                                        X: {inferredMapping.xField || '无'} / Y: {inferredMapping.yField || '无'} / Group: {inferredMapping.groupField || '无'}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span>{isParsingData ? '解析中...' : '待解析'}</span>
                                )}
                              </div>
                            </div>
                            <button
                              onClick={() => setAsPrimaryDataset(item.id)}
                              className={`px-2 py-1 text-xs rounded border transition-colors flex items-center gap-1 ${
                                isPrimary
                                  ? 'border-blue-300 bg-white text-blue-700'
                                  : 'border-slate-200 bg-white text-slate-600 hover:text-blue-700 hover:border-blue-200'
                              }`}
                              type="button"
                            >
                              <Star className="w-3 h-3" />
                              {isPrimary ? '主数据' : '设为主数据'}
                            </button>
                            <button
                              onClick={() => removePendingFile(item.id)}
                              className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                              type="button"
                              title="移除文件"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm text-slate-400">
                      还没有选择数据文件
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 grid lg:grid-cols-[1.1fr,0.9fr] gap-6">
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-700 flex items-center justify-between">
                  <span>主数据预览（前 5 行）</span>
                  <span className="text-xs text-slate-500">
                    {primaryDataset ? primaryDataset.file.name : '未选择主数据'}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left whitespace-nowrap">
                    <thead className="bg-slate-50 border-b border-slate-200 font-mono text-xs text-slate-500">
                      <tr>
                        {headers.map(header => <th key={header} className="px-4 py-2">{header}</th>)}
                        {headers.length === 0 && <th className="px-4 py-2">请先选择主数据文件</th>}
                      </tr>
                    </thead>
                    <tbody className="font-mono text-slate-800">
                      {previewData.map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-b border-slate-100">
                          {headers.map(header => (
                            <td key={header} className="px-4 py-2">
                              {row[header] !== undefined && row[header] !== null ? String(row[header]) : ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {previewData.length > 0 && (
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                          {headers.map(header => <td key={header} className="px-4 py-2 text-slate-400">...</td>)}
                        </tr>
                      )}
                      {previewData.length === 0 && (
                        <tr>
                          <td className="px-4 py-4 text-slate-400">
                            {isParsingData ? '解析中...' : '暂无可预览数据'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 text-xs text-slate-500">
                  共 {allData.length} 行数据，{headers.length} 列字段
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 p-4 bg-slate-50 space-y-4">
                <div>
                  <div className="text-sm font-semibold text-slate-800 mb-3">字段识别与映射</div>
                  <div className="grid grid-cols-1 gap-3">
                    <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-white">
                      <span className="font-semibold text-slate-700 text-sm">X 轴 / 分类列</span>
                      <select value={xField} onChange={e => setXField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                        {headers.length > 0 ? headers.map(header => <option key={header}>{header}</option>) : <option>无数据</option>}
                      </select>
                    </div>
                    <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-white">
                      <span className="font-semibold text-slate-700 text-sm">Y 轴 / 数值列</span>
                      <select value={yField} onChange={e => setYField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                        {headers.length > 0 ? headers.map(header => <option key={header}>{header}</option>) : <option>无数据</option>}
                      </select>
                    </div>
                    <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-white">
                      <span className="font-semibold text-slate-700 text-sm">分组列</span>
                      <select value={groupField} onChange={e => setGroupField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                        <option value="">无分组</option>
                        {headers.map(header => <option key={header}>{header}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-white">
                      <span className="font-semibold text-slate-700 text-sm">误差列</span>
                      <select value={errField} onChange={e => setErrField(e.target.value)} className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white font-mono">
                        <option value="">无</option>
                        {headers.map(header => <option key={header}>{header}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-600">自动识别结果</div>
                  <div className="text-sm text-slate-700 leading-6">
                    <div>文本列：{stringFields.length > 0 ? stringFields.join(', ') : '无'}</div>
                    <div>数值列：{numericFields.length > 0 ? numericFields.join(', ') : '无'}</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-800 mb-2">2. 准备 Python 脚本</h2>
                <p className="text-sm text-slate-500 leading-6">
                  现在脚本有真实数据上下文。你可以直接粘贴现有脚本、拖入 `.py` 文件，或者先走网页 AI 改写。
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                当前约 {scriptLineCount} 行
              </div>
            </div>

            <div className="mt-5 grid lg:grid-cols-[1.2fr,0.8fr] gap-6">
              <div className="space-y-4">
                <div
                  className={`relative border-2 border-dashed rounded-lg transition-colors ${
                    scriptDragOver ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-white'
                  }`}
                  onDragOver={e => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    setScriptDragOver(true);
                  }}
                  onDragLeave={() => setScriptDragOver(false)}
                  onDrop={e => {
                    e.preventDefault();
                    setScriptDragOver(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) readScriptFile(file);
                  }}
                >
                  {scriptDragOver && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                      <div className="bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-semibold">
                        松开以上传 .py 文件
                      </div>
                    </div>
                  )}
                  <textarea
                    value={script}
                    onChange={e => setScript(e.target.value)}
                    className="w-full h-[360px] p-5 text-sm font-mono leading-relaxed border-0 resize-none focus:outline-none bg-transparent text-slate-800"
                    placeholder="粘贴或编写 Python 脚本，或拖入 .py 文件"
                    spellCheck={false}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".py"
                    className="hidden"
                    onChange={handleScriptFileUpload}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
                    type="button"
                  >
                    <Upload className="w-4 h-4" />
                    上传 .py
                  </button>
                  <button
                    onClick={handleClear}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
                    type="button"
                  >
                    <Trash2 className="w-4 h-4" />
                    恢复示例脚本
                  </button>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <div className="text-sm font-semibold text-amber-800 mb-2">如果你要走网页 AI 改写</div>
                  <ol className="space-y-2 text-sm text-amber-700 leading-6">
                    <li>1. 先确认主数据文件和字段映射是对的。</li>
                    <li>2. 点击“复制 AI 提示词”。</li>
                    <li>3. 到 ChatGPT / Gemini / DeepSeek 粘贴。</li>
                    <li>4. 把结果粘贴回下方并应用。</li>
                  </ol>
                  <button
                    onClick={handleCopyPrompt}
                    className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
                    type="button"
                  >
                    <ClipboardCopy className="w-4 h-4" />
                    {copyLabel}
                  </button>
                </div>

                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-2 text-sm font-semibold text-slate-700">
                    <FileCode2 className="w-4 h-4 text-indigo-600" />
                    AI 改写结果粘贴区
                  </div>
                  <textarea
                    value={aiResult}
                    onChange={e => setAiResult(e.target.value)}
                    className="w-full h-[220px] p-4 text-sm font-mono leading-relaxed border-0 resize-none focus:outline-none bg-white text-slate-800"
                    placeholder="把 AI 返回的 Python 代码粘贴到这里，然后点击下方按钮覆盖左侧脚本"
                    spellCheck={false}
                  />
                  <div className="px-4 py-3 border-t border-slate-200 bg-white">
                    <button
                      onClick={applyAiResult}
                      disabled={!aiResult.trim()}
                      className="w-full py-2.5 bg-indigo-600 text-white rounded-md font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      type="button"
                    >
                      应用 AI 结果到脚本区
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-700">
                    本次发送给 AI 的真实数据提示
                  </div>
                  <textarea
                    readOnly
                    rows={10}
                    value={aiPrompt}
                    className="w-full p-4 text-xs font-mono bg-white text-slate-700 border-0 resize-none focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
              <div>
                <h2 className="text-lg font-bold text-slate-800 mb-2">3. 创建项目并进入编辑器</h2>
                <p className="text-sm text-slate-500 leading-6">
                  这里才真正创建项目。平台会按顺序完成：创建项目、上传数据、保存脚本、载入编辑器。主数据文件会优先上传并作为 `_uploaded_data` 注入。
                </p>
              </div>
              <div className="grid sm:grid-cols-3 gap-3 lg:min-w-[420px]">
                {[
                  ['项目名称', name.trim() || '未命名项目'],
                  ['主数据', primaryDataset?.file.name || '未选择'],
                  ['脚本状态', hasScript ? '已准备' : '未准备'],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="text-xs font-semibold text-slate-500 mb-1">{label}</div>
                    <div className="text-sm font-semibold text-slate-800 truncate" title={String(value)}>{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 grid lg:grid-cols-[1fr,1fr] gap-6">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <label className="block text-sm font-semibold text-slate-700 mb-2">项目名称</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="输入项目名称"
                />
              </div>

              <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 p-6 text-white">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold mb-4">
                  最终动作
                </div>
                <div className="space-y-4">
                  {[
                    '先创建本地项目记录。',
                    '按“主数据优先”的顺序上传所有文件。',
                    '保存当前脚本并直接跳转到编辑器。',
                  ].map(text => (
                    <div key={text} className="flex gap-3 text-sm leading-6 text-slate-100/90">
                      <ChevronRight className="w-4 h-4 mt-1 shrink-0 text-blue-200" />
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between gap-3 flex-wrap">
              <button
                onClick={() => onNavigate('data_import')}
                className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
                type="button"
              >
                <FileDown className="w-4 h-4" />
                改走旧版数据导入流程
              </button>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => onNavigate('home')}
                  className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                  type="button"
                >
                  取消
                </button>
                <button
                  onClick={createProjectAndEnter}
                  disabled={submitting || !dataReady || !hasScript}
                  className="px-6 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2"
                  type="button"
                >
                  <Play className="w-4 h-4" />
                  {submitting ? '创建并上传中...' : isParsingData ? '等待数据解析...' : '创建项目并进入编辑器'}
                </button>
              </div>
            </div>
          </section>
        </div>

        {rightPanel}
      </div>
    </div>
  );
}
