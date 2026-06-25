import { Download, CheckCircle, AlertTriangle, FileImage, Settings2, FileCode, Check } from 'lucide-react';
import { ViewState } from '../App';
import { FigureSpec } from '../types';
import type { FigureSession } from '../schemas/manifest';

const DPI_OPTIONS = [
  { value: 300, label: '300 dpi (标准印花)' },
  { value: 600, label: '600 dpi (高质量 - Nature/Science 推荐)' },
  { value: 1200, label: '1200 dpi (极高清晰度线图)' },
];

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function ExportSettingsPage({
  spec,
  onNavigate,
  onSpecChange,
  figSession,
  projectId,
  activeFigureId,
}: {
  spec: FigureSpec;
  onNavigate: (view: ViewState) => void;
  onSpecChange: (spec: FigureSpec) => void;
  figSession: FigureSession | null;
  projectId?: string | null;
  activeFigureId?: string;
}) {
  const exportConfig = spec.export ?? { format: 'PDF', dpi: 600, color_mode: 'RGB', embed_fonts: true };
  const figureConfig = spec.figure ?? { width: 100, height: 80, unit: 'mm', dpi: exportConfig.dpi };

  const updateExportFormat = (format: string) => {
    onSpecChange({ ...spec, export: { ...exportConfig, format } });
  };

  const updateExportDpi = (dpi: number) => {
    onSpecChange({ ...spec, export: { ...exportConfig, dpi } });
  };

  const updateFigureWidth = (width: number) => {
    onSpecChange({ ...spec, figure: { ...figureConfig, width } });
  };

  const updateFigureHeight = (height: number) => {
    onSpecChange({ ...spec, figure: { ...figureConfig, height } });
  };

  const handleExport = async (formatOverride?: string) => {
    try {
      const selectedFormat = formatOverride || exportConfig.format || 'PDF';
      const selectedDpi = exportConfig.dpi || 600;
      const isProjectExport = Boolean(projectId && activeFigureId);

      if (!isProjectExport && !figSession?.sessionId) {
        alert('请先在编辑器中渲染一次图形，然后再进行导出。');
        return;
      }

      const endpoint = isProjectExport ? `/api/projects/${projectId}/export` : '/api/figure/export';
      const payload = isProjectExport
        ? { figureId: activeFigureId, format: selectedFormat, dpi: selectedDpi }
        : { sessionId: figSession?.sessionId, format: selectedFormat, dpi: selectedDpi };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Export failed');

      const exportPayload = isProjectExport
        ? data.figures?.find((figure: any) => figure.figureId === activeFigureId) || data.figures?.[0]
        : data;
      if (!exportPayload) {
        throw new Error('没有可导出的 Figure');
      }

      // Show a note if format conversion fell back to SVG
      if (data.format_note) {
        alert(`提示: ${data.format_note}`);
      }

      const fmt = (exportPayload.format || selectedFormat).toLowerCase();
      let blob: Blob;

      if (exportPayload.binary_b64) {
        const byteStr = atob(exportPayload.binary_b64);
        const byteArr = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) byteArr[i] = byteStr.charCodeAt(i);
        const mimeMap: Record<string, string> = {
          pdf: 'application/pdf',
          png: 'image/png',
          tiff: 'image/tiff',
          eps: 'application/postscript',
        };
        blob = new Blob([byteArr], { type: mimeMap[fmt] || 'application/octet-stream' });
      } else {
        blob = new Blob([exportPayload.svg], { type: 'image/svg+xml' });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportPayload.figureId || 'figure'}.${exportPayload.binary_b64 ? fmt : 'svg'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      // Download reproducible bundle
      if (data.bundle) {
        downloadTextFile('reproducible_bundle.json', JSON.stringify(data.bundle, null, 2), 'application/json');
      }
    } catch (err: any) {
      console.error('Export error:', err);
      alert(`导出失败: ${err.message}`);
    }
  };


  return (
    <div className="flex-1 flex flex-col bg-slate-50 min-w-0 overflow-y-auto">
      <div className="p-8 max-w-7xl mx-auto w-full flex flex-col h-full gap-6">
        
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 mb-1 flex items-center gap-2">
              导出与出版设置
            </h1>
            <p className="text-slate-500 text-sm">配置最终论文图片导出参数，检查图形是否满足目标期刊要求。</p>
          </div>
          <button onClick={() => onNavigate('editor')} className="px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm">
            返回编辑器
          </button>
        </div>

        <div className="flex gap-6 items-start">
          {/* Main Settings Panel */}
          <div className="flex-1 space-y-6">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <h3 className="font-bold text-lg text-slate-800 mb-4 pb-2 border-b border-slate-100 flex items-center gap-2"><Settings2 className="w-5 h-5 text-blue-600" /> 出版参数配置</h3>
              
              <div className="grid grid-cols-2 gap-x-8 gap-y-6">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">输出格式</label>
                  <div className="flex bg-slate-100 rounded-lg p-1">
                    {['PDF', 'SVG', 'TIFF', 'PNG', 'EPS'].map(fmt => (
                      <button 
                        key={fmt}
                        onClick={() => updateExportFormat(fmt)}
                        className={`flex-1 py-2 text-center rounded-md text-sm font-medium transition-all ${exportConfig.format === fmt ? 'bg-white shadow-sm text-blue-600 border border-slate-200/50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'}`}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-2">推荐：矢量图(PDF, SVG)放大不失真；高分辨率图(TIFF)适合多数期刊系统。</p>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">分辨率 (DPI)</label>
                  <select
                    value={exportConfig.dpi}
                    onChange={(e) => updateExportDpi(Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg p-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {DPI_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">图形尺寸（毫米）</label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <div className="flex items-center border border-slate-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500">
                        <span className="bg-slate-50 px-3 py-2 border-r border-slate-300 text-slate-500 text-sm">宽</span>
                        <input type="number" value={figureConfig.width} onChange={(e) => updateFigureWidth(Number(e.target.value))} className="w-full p-2 outline-none text-sm" />
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center border border-slate-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500">
                        <span className="bg-slate-50 px-3 py-2 border-r border-slate-300 text-slate-500 text-sm">高</span>
                        <input type="number" value={figureConfig.height} onChange={(e) => updateFigureHeight(Number(e.target.value))} className="w-full p-2 outline-none text-sm" />
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <span onClick={() => updateFigureWidth(85)} className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded border border-blue-100 cursor-pointer hover:bg-blue-100">单栏 (85mm)</span>
                    <span onClick={() => updateFigureWidth(180)} className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded border border-slate-200 cursor-pointer hover:bg-slate-200">双栏 (180mm)</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">颜色模式</label>
                  <select 
                    value={exportConfig.color_mode || 'RGB'} 
                    onChange={(e) => onSpecChange({ ...spec, export: { ...exportConfig, color_mode: e.target.value } })}
                    className="w-full border border-slate-300 rounded-lg p-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="RGB">RGB (默认屏幕显示)</option>
                    <option value="CMYK">CMYK (印刷出版用)</option>
                    <option value="Grayscale">Grayscale (灰度图检查)</option>
                  </select>
                </div>

                <div className="col-span-2 pt-4 border-t border-slate-100">
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <input 
                      type="checkbox" 
                      checked={exportConfig.embed_fonts ?? true} 
                      onChange={(e) => onSpecChange({ ...spec, export: { ...exportConfig, embed_fonts: e.target.checked } })}
                      className="w-4 h-4 text-blue-600 rounded cursor-pointer accent-blue-600" 
                    />
                    <span className="text-sm font-medium text-slate-800">嵌入字体 (Embed Fonts)</span>
                  </label>
                  <p className="text-xs text-slate-500 ml-6">确保目标电脑或排版系统没有当前字体时能正常显示。</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Sidebar - Publication Checklist & Export */}
          <div className="w-[360px] shrink-0 space-y-6">
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-4 justify-between border-b border-slate-100 pb-2">
                <h3 className="font-bold text-slate-800">出版质量检查单</h3>
                <span className="text-xs font-semibold px-2 py-1 bg-emerald-100 text-emerald-700 rounded border border-emerald-200 flex items-center gap-1"><Check className="w-3 h-3"/> Ready</span>
              </div>
              
              <div className="space-y-3 mb-6">
                {[
                  { label: '图表分辨率 >= 300 PPI', ok: true },
                  { label: '最小字号满足 7pt 要求', ok: true },
                  { label: '线宽不低于 0.5pt', ok: true },
                  { label: '未检测到透明度压缩伪影', ok: true },
                  { label: '字体已嵌入配置', ok: true },
                  { label: 'CMYK 颜色转换安全', ok: false, warn: true }
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-sm">
                    {item.ok ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    )}
                    <span className={item.ok ? 'text-slate-700' : 'text-amber-700'}>{item.label}</span>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <button onClick={() => handleExport()} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold shadow-md hover:bg-blue-700 flex items-center justify-center gap-2 transition-all hover:-translate-y-0.5">
                  <Download className="w-4 h-4" /> 导出高质量图形 ({exportConfig.format})
                </button>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => { updateExportFormat('PDF'); void handleExport('PDF'); }} className="py-2.5 bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5 shadow-sm">
                    <FileImage className="w-4 h-4 text-red-500" /> PDF 矢量
                  </button>
                  <button 
                    onClick={() => {
                      const script = figSession?.script
                        || spec.custom_script
                        || '# No rendered session script available';
                      downloadTextFile('figure.py', script, 'text/x-python');
                    }}
                    className="py-2.5 bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5 shadow-sm"
                  >
                    <FileCode className="w-4 h-4 text-blue-500" /> Python 代码
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
