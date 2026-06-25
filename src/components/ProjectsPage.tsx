import { useState, useEffect, useRef, type MouseEvent, type KeyboardEvent } from 'react';
import { Search, Folder, Users, Trash2, FileText, Loader2, Trash, ExternalLink, Pencil } from 'lucide-react';

interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  group_count: number;
  sample_count: number;
  preview: string | null;
}

export function ProjectsPage({ subView, onNavigate, onLoadProject }: {
  subView?: string;
  onNavigate: (view: string) => void;
  onLoadProject: (id: string, name: string, data: any) => void;
}) {
  const title = subView === 'trash' ? '回收站' : subView === 'shared' ? '与我共享' : '我的项目';
  const icon = subView === 'trash' ? <Trash2 className="w-5 h-5" /> : subView === 'shared' ? <Users className="w-5 h-5" /> : <Folder className="w-5 h-5" />;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const fetchProjects = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (data.status === 'success') setProjects(data.projects);
      else setProjects([]);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProjects(); }, [subView]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleDelete = async (id: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定删除此项目？')) return;
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    fetchProjects();
  };

  const handleOpen = async (id: string, name: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      if (data.status === 'success') {
        onLoadProject(id, name, data.project);
      }
    } catch (e) {
      alert('加载项目失败');
    }
  };

  const startRename = (id: string, currentName: string, e: MouseEvent) => {
    e.stopPropagation();
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const commitRename = async (id: string) => {
    const newName = renameValue.trim();
    if (!newName || newName === projects.find(p => p.id === id)?.name) {
      setRenamingId(null);
      return;
    }
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, spec: null }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setRenamingId(null);
        fetchProjects();
      } else {
        alert('重命名失败：' + (data.message || ''));
        setRenamingId(null);
      }
    } catch {
      alert('重命名失败：网络错误');
      setRenamingId(null);
    }
  };

  const handleRenameKeyDown = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(id); }
    if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
  };

  const handleRenameBlur = (id: string) => {
    // Only commit if user didn't just press Enter (handled by onKeyDown)
    setTimeout(() => commitRename(id), 150);
  };

  const filtered = projects.filter(p => p.name.includes(searchQuery));

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            {icon} {title}
          </h1>
          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="搜索项目..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
              />
            </div>
            <button
              onClick={() => onNavigate('project_create')}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 shadow-sm"
            >
              新建项目
            </button>
          </div>
        </div>

        <div className="grid gap-4">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-slate-400 bg-white border border-slate-200 rounded-xl shadow-sm">
              <Loader2 className="w-6 h-6 animate-spin mr-2" /> 加载中...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400 bg-white border border-slate-200 rounded-xl shadow-sm">
              <Folder className="w-12 h-12 mb-3 text-slate-300" />
              <p className="text-sm">{projects.length === 0 ? '暂无项目，点击"新建项目"创建' : '未匹配到搜索条件'}</p>
            </div>
          ) : (
            filtered.map(p => (
              <div
                key={p.id}
                className="bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-shadow flex items-stretch overflow-hidden cursor-pointer group"
                onClick={() => handleOpen(p.id, p.name)}
              >
                <div className="w-24 h-20 bg-white flex items-center justify-center shrink-0 border-r border-slate-200 overflow-hidden">
                  {p.preview?.startsWith('data:') ? (
                    <img src={p.preview} alt="" className="w-full h-full object-contain" />
                  ) : (
                    <FileText className="w-8 h-8 text-slate-300" />
                  )}
                </div>
                <div className="flex-1 flex items-center justify-between px-5 py-3 min-w-0">
                  <div className="min-w-0 flex-1">
                    {renamingId === p.id ? (
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={() => handleRenameBlur(p.id)}
                        onKeyDown={e => handleRenameKeyDown(e, p.id)}
                        onClick={e => e.stopPropagation()}
                        className="text-sm font-semibold text-slate-800 border border-blue-300 rounded px-1.5 py-0.5 bg-blue-50 outline-none w-full max-w-xs"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800 truncate">{p.name}</span>
                        <Pencil
                          className="w-3.5 h-3.5 text-slate-300 hover:text-blue-600 cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={e => startRename(p.id, p.name, e)}
                        />
                      </div>
                    )}
                    <div className="text-xs text-slate-500 mt-0.5">{p.group_count} 组 · {p.sample_count} 个样品</div>
                  </div>
                  <div className="text-xs text-slate-400 text-right shrink-0 ml-4 leading-tight">
                    <div>{p.updated_at}</div>
                    <div className="text-slate-300 mt-0.5">{p.created_at}</div>
                  </div>
                  <div className="flex items-center gap-1 ml-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); startRename(p.id, p.name, e); }}
                      className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      title="重命名"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(p.id, e)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="删除"
                    >
                      <Trash className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}

          <div className="flex items-center justify-between text-sm text-slate-500 px-1">
            <div>共 {filtered.length} 个项目</div>
          </div>
        </div>
      </div>
    </div>
  );
}
