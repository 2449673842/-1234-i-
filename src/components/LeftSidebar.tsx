import React, { useMemo, useState, type ReactNode } from 'react';
import { FileCode, FileSpreadsheet, FileJson, Layout, Eye, EyeOff, ChevronDown, ChevronRight, Type, BarChart, Box, Lock, Unlock } from 'lucide-react';
import { FigureSession, ManifestObject, PatchEntry, Binding } from '../schemas/manifest';
import { FigureSpec, DatasetEntry } from '../types';

interface LeftSidebarProps {
  spec: FigureSpec;
  selectedObject?: string;
  onSelectObject?: (object: string) => void;
  selectedGids?: string[];
  onSelectGids?: (gids: string[]) => void;
  figSession?: FigureSession | null;
  lockedObjects?: Set<string>;
  onToggleLock?: (gid: string) => void;
  onPatch?: (patches: PatchEntry[]) => void;
  
  // V3.2A Project Layer
  projectId?: string | null;
  datasets?: DatasetEntry[];
  onUploadFile?: (file: File) => Promise<void>;
  onDeleteFile?: (fileId: string) => Promise<void>;
  onSelectResourceFile?: (filename: string) => void;
  activeResourceFile?: string;
}

interface TreeNode {
  id: string;
  label: string;
  subtitle?: string;
  badge?: string;
  swatch?: string;
  icon?: ReactNode;
  children?: TreeNode[];
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  expanded: Record<string, boolean>;
  visibleMap: Record<string, boolean>;
  selectedObject: string;
  onSelectObject: (id: string) => void;
  selectedGids: string[];
  onSelectGids: (gids: string[]) => void;
  allFlatNodes: TreeNode[];
  onToggleExpand: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  lockedObjects?: Set<string>;
  onToggleLock?: (gid: string) => void;
  onDragStart?: (e: React.DragEvent, id: string) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent, id: string) => void;
}

function TreeItem({
  node,
  depth,
  expanded,
  visibleMap,
  selectedObject,
  onSelectObject,
  selectedGids,
  onSelectGids,
  allFlatNodes,
  onToggleExpand,
  onToggleVisibility,
  lockedObjects,
  onToggleLock,
  onDragStart,
  onDragOver,
  onDrop,
}: TreeItemProps) {
  const hasChildren = Boolean(node.children?.length);
  const isExpanded = expanded[node.id] ?? true;
  const isVisible = visibleMap[node.id] !== false;
  const isSelected = selectedObject === node.id;
  const isMultiSelected = selectedGids.includes(node.id);
  const isLocked = lockedObjects?.has(node.id);
  const isVirtualNode = node.id.endsWith('_Section') || node.id === 'Figure';

  const childItems = hasChildren && isExpanded
    ? node.children!.map(child => (
      <div key={child.id}>
        <TreeItem
          node={child}
          depth={depth + 1}
          expanded={expanded}
          visibleMap={visibleMap}
          selectedObject={selectedObject}
          onSelectObject={onSelectObject}
          selectedGids={selectedGids}
          onSelectGids={onSelectGids}
          allFlatNodes={allFlatNodes}
          onToggleExpand={onToggleExpand}
          onToggleVisibility={onToggleVisibility}
          lockedObjects={lockedObjects}
          onToggleLock={onToggleLock}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
        />
      </div>
    ))
    : null;

  const isDraggable = !isVirtualNode;

  return (
    <div
      className="w-full"
      draggable={isDraggable}
      onDragStart={(e) => {
        if (!isDraggable) return;
        e.dataTransfer.setData("text/plain", node.id);
        onDragStart?.(e, node.id);
      }}
      onDragOver={(e) => {
        if (!isDraggable) return;
        e.preventDefault();
        onDragOver?.(e);
      }}
      onDrop={(e) => {
        if (!isDraggable) return;
        e.preventDefault();
        onDrop?.(e, node.id);
      }}
    >
      <div
        className={`flex items-center justify-between group py-1.5 pr-2 rounded cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 text-blue-700 font-medium' : isMultiSelected ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-slate-100 text-slate-700'}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) {
            const next = selectedGids.includes(node.id)
              ? selectedGids.filter(g => g !== node.id)
              : [...selectedGids, node.id];
            onSelectGids(next);
          } else if (event.shiftKey && selectedGids.length > 0) {
            const lastId = selectedGids[selectedGids.length - 1];
            const idx1 = allFlatNodes.findIndex(n => n.id === lastId);
            const idx2 = allFlatNodes.findIndex(n => n.id === node.id);
            if (idx1 !== -1 && idx2 !== -1) {
              const start = Math.min(idx1, idx2);
              const end = Math.max(idx1, idx2);
              const range = allFlatNodes.slice(start, end + 1).map(n => n.id);
              const next = Array.from(new Set([...selectedGids, ...range]));
              onSelectGids(next);
            }
          } else {
            onSelectGids([node.id]);
            onSelectObject(node.id);
          }
        }}
      >
        <div className={`flex items-center gap-1.5 min-w-0 ${!isVisible ? 'opacity-40' : ''}`}>
          {hasChildren ? (
            <button type="button" onClick={event => { event.stopPropagation(); onToggleExpand(node.id); }} className="w-4 h-4 flex items-center justify-center shrink-0">
              {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />}
            </button>
          ) : (
            <span className="w-4 h-4 shrink-0"></span>
          )}
          {node.icon && <span className="text-slate-400 shrink-0">{node.icon}</span>}
          <span className="min-w-0 flex flex-col">
            <span className="flex items-center gap-1.5 min-w-0">
              {node.swatch && (
                <span
                  className="w-2.5 h-2.5 rounded-full border border-white shadow-sm shrink-0"
                  style={{ backgroundColor: node.swatch }}
                />
              )}
              <span className="text-sm truncate select-none">{node.label}</span>
              {node.badge && (
                <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] leading-none text-slate-500 shrink-0">
                  {node.badge}
                </span>
              )}
            </span>
            {node.subtitle && (
              <span className="text-[10px] leading-tight text-slate-400 truncate select-none">
                {node.subtitle}
              </span>
            )}
          </span>
        </div>
        
        {!isVirtualNode && (
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={event => { event.stopPropagation(); onToggleLock?.(node.id); }}
              className={`mr-1.5 transition-opacity ${isLocked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
              title={isLocked ? "解锁图层" : "锁定图层"}
            >
              {isLocked ? (
                <Lock className="w-3.5 h-3.5 text-amber-500" />
              ) : (
                <Unlock className="w-3.5 h-3.5 text-slate-300 hover:text-slate-500" />
              )}
            </button>
            <button
              type="button"
              onClick={event => { event.stopPropagation(); onToggleVisibility(node.id); }}
              className="text-slate-400 hover:text-slate-600"
              title={isVisible ? "隐藏图层" : "显示图层"}
            >
              {isVisible ? (
                <Eye className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 transition-colors" />
              ) : (
                <EyeOff className="w-3.5 h-3.5 text-slate-300 hover:text-slate-500 transition-colors" />
              )}
            </button>
          </div>
        )}
      </div>
      {hasChildren && isExpanded && childItems}
    </div>
  );
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const n of nodes) {
    result.push(n);
    if (n.children) result.push(...flattenTree(n.children));
  }
  return result;
}

export function LeftSidebar({
  spec,
  selectedObject = 'Figure',
  onSelectObject = () => {},
  selectedGids = [],
  onSelectGids = () => {},
  figSession,
  lockedObjects,
  onToggleLock,
  onPatch,
  projectId = null,
  datasets = [],
  onUploadFile,
  onDeleteFile,
  onSelectResourceFile,
  activeResourceFile = 'figure_spec.json',
}: LeftSidebarProps) {
  const [activeFile, setActiveFile] = useState<string>('figure_spec.json');
  const [searchTerm, setSearchTerm] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    Figure: true,
    Canvas_Section: true,
    Axes_Section: true,
    Data_Section: true,
    Legend_Section: true,
  });

  const tree = useMemo<TreeNode[]>(() => {
    const objects = figSession?.manifest?.objects || [];

    const truncateText = (value: unknown, max = 36) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    };

    const roleLabel = (o: ManifestObject) => {
      if (o.role === 'axes_title' || o.id.startsWith('title.')) return '标题';
      if (o.role === 'x_axis_label' || o.id.startsWith('xlabel.')) return 'X标签';
      if (o.role === 'y_axis_label' || o.id.startsWith('ylabel.')) return 'Y标签';
      if (o.role === 'x_tick_label' || o.id.startsWith('xtick.')) return 'X刻度';
      if (o.role === 'y_tick_label' || o.id.startsWith('ytick.')) return 'Y刻度';
      if (o.id.startsWith('legend_text.')) return '图例文字';
      if (o.id.startsWith('legend_title.')) return '图例标题';
      if (o.id.startsWith('fig_text.')) return '全局文字';
      if (o.kind === 'text') return '文本';
      if (o.kind === 'subplot') return '子图';
      return undefined;
    };

    const nodeForObject = (o: ManifestObject, icon?: ReactNode): TreeNode => {
      const isText = o.kind === 'text';
      const textValue = isText ? truncateText(o.currentProps.text, 42) : '';
      const fontSize = typeof o.currentProps.fontsize === 'number' ? `${Number(o.currentProps.fontsize).toFixed(1)}pt` : '';
      const fontWeight = typeof o.currentProps.fontweight === 'string' && o.currentProps.fontweight !== 'normal' ? o.currentProps.fontweight : '';
      const fontStyle = typeof o.currentProps.fontstyle === 'string' && o.currentProps.fontstyle !== 'normal' ? o.currentProps.fontstyle : '';
      const color = typeof o.currentProps.color === 'string' ? o.currentProps.color : undefined;
      const badge = roleLabel(o);
      return {
        id: o.id,
        label: isText ? (textValue || o.label || o.id) : (o.label || o.id),
        subtitle: isText ? [fontSize, fontWeight, fontStyle, o.id].filter(Boolean).join(' · ') : undefined,
        badge,
        swatch: isText ? color : undefined,
        icon: icon || (isText ? <Type className="w-3.5 h-3.5" /> : <Box className="w-3.5 h-3.5" />),
      };
    };

    const getAxesIndex = (o: ManifestObject): number | null => {
      if (typeof o.source?.axesIndex === 'number') return o.source.axesIndex;
      const match = o.id.match(/(?:subplot|axes|grid|spine_group|axis\.[xy]|title|xlabel|ylabel|xtick|ytick|legend|legend_text|legend_title|line|collection|patch|heatmap|colorbar)\.(?:[a-z]+\.)?(\d+)/);
      return match ? Number(match[1]) : null;
    };

    const getSubplotId = (o: ManifestObject): string | null => {
      if (o.kind === 'subplot') return o.id;
      if (typeof o.subplotId === 'string') return o.subplotId;
      const idx = getAxesIndex(o);
      return idx === null ? null : `subplot.${idx}`;
    };

    const canvasObjects = objects.filter(o =>
      o.id === 'Background' ||
      o.id === 'Export Boundary' ||
      o.id.startsWith('fig_text.') ||
      o.id === 'patch_1'
    );
    const canvasNodes = canvasObjects.map(o => nodeForObject(o, o.id.startsWith('fig_text.') ? <Type className="w-3.5 h-3.5" /> : undefined));

    const subplotObjects = objects
      .filter(o => o.kind === 'subplot')
      .sort((a, b) => Number(a.currentProps.subplotIndex ?? getAxesIndex(a) ?? 0) - Number(b.currentProps.subplotIndex ?? getAxesIndex(b) ?? 0));

    const axisLike = (o: ManifestObject) => (
      o.kind === 'axes' ||
      o.kind === 'axis_x' ||
      o.kind === 'axis_y' ||
      o.kind === 'spine' ||
      o.kind === 'spine_group' ||
      o.kind === 'grid' ||
      o.id.startsWith('xtick.') ||
      o.id.startsWith('ytick.') ||
      o.id.startsWith('xlabel.') ||
      o.id.startsWith('ylabel.') ||
      o.id.startsWith('title.')
    );
    const legendLike = (o: ManifestObject) => o.id.startsWith('legend');
    const textLike = (o: ManifestObject) => o.kind === 'text' && !legendLike(o) && !axisLike(o);
    const dataLike = (o: ManifestObject) => (
      !canvasObjects.some(co => co.id === o.id) &&
      o.kind !== 'figure' &&
      o.kind !== 'subplot' &&
      !axisLike(o) &&
      !legendLike(o) &&
      !textLike(o)
    );

    const subplotNodes = subplotObjects.map((subplot) => {
      const subplotId = subplot.id;
      const inSubplot = (o: ManifestObject) => getSubplotId(o) === subplotId;
      const axisNodes = objects.filter(o => inSubplot(o) && axisLike(o)).map(o => nodeForObject(o));
      const textNodes = objects.filter(o => inSubplot(o) && textLike(o)).map(o => nodeForObject(o, <Type className="w-3.5 h-3.5" />));
      const dataNodes = objects.filter(o => inSubplot(o) && dataLike(o)).map(o => nodeForObject(o, <BarChart className="w-3.5 h-3.5 text-indigo-400" />));
      const legendNodes = objects.filter(o => inSubplot(o) && legendLike(o)).map(o => nodeForObject(o, o.kind === 'text' ? <Type className="w-3.5 h-3.5" /> : undefined));
      return {
        id: `${subplotId}_Section`,
        label: String(subplot.currentProps.label || subplot.label || subplotId),
        icon: <Layout className="w-3.5 h-3.5 text-blue-500" />,
        children: [
          nodeForObject(subplot, <Layout className="w-3.5 h-3.5 text-blue-500" />),
          { id: `${subplotId}_Text`, label: '文字 / 标题 / 注释', children: textNodes.length ? textNodes : [{ id: `${subplotId}_text_empty`, label: '无独立注释' }] },
          { id: `${subplotId}_Axes`, label: '坐标轴 / 框线 / 刻度', children: axisNodes.length ? axisNodes : [{ id: `${subplotId}_axes_empty`, label: '无坐标轴对象' }] },
          { id: `${subplotId}_Data`, label: '数据图层', children: dataNodes.length ? dataNodes : [{ id: `${subplotId}_data_empty`, label: '无数据对象' }] },
          { id: `${subplotId}_Legend`, label: '图例', children: legendNodes.length ? legendNodes : [{ id: `${subplotId}_legend_empty`, label: '无图例' }] },
        ],
      };
    });

    const assignedGids = new Set<string>();
    subplotNodes.forEach(node => {
      const collect = (items?: TreeNode[]) => items?.forEach(item => {
        assignedGids.add(item.id);
        collect(item.children);
      });
      collect(node.children);
    });
    const unassignedNodes = objects
      .filter(o => !assignedGids.has(o.id) && !canvasObjects.some(co => co.id === o.id) && o.kind !== 'figure')
      .map(o => nodeForObject(o));

    return [
      {
        id: 'Figure',
        label: '全局图像 (Figure)',
        children: [
          {
            id: 'Canvas_Section',
            label: '画布与边界 (Canvas)',
            children: canvasNodes.length > 0 ? canvasNodes : [{ id: 'canvas_empty', label: '无画布元素' }],
          },
          {
            id: 'Subplots_Section',
            label: '子图结构 (Subplots)',
            children: subplotNodes.length > 0 ? subplotNodes : [{ id: 'subplot_empty', label: '无子图对象' }],
          },
          {
            id: 'Unassigned_Section',
            label: '未归类对象',
            children: unassignedNodes.length > 0 ? unassignedNodes : [{ id: 'unassigned_empty', label: '无未归类对象' }],
          },
        ]
      }
    ];
  }, [figSession?.manifest, spec]);

  const filteredTree = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return tree;

    const filterNode = (node: TreeNode): TreeNode | null => {
      const selfMatch = node.label.toLowerCase().includes(term) || node.id.toLowerCase().includes(term);
      const children = node.children?.map(filterNode).filter(Boolean) as TreeNode[] | undefined;
      if (selfMatch || (children && children.length > 0)) {
        return { ...node, children };
      }
      return null;
    };

    return tree.map(filterNode).filter(Boolean) as TreeNode[];
  }, [searchTerm, tree]);

  // Compute actual GID visibility map from manifest object property 'visible'
  const visibleMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    const objects = figSession?.manifest?.objects || [];
    objects.forEach(obj => {
      map[obj.id] = obj.currentProps.visible !== false;
    });

    // Add logical groups visibility to visibleMap
    const groups = figSession?.manifest?.groups || [];
    const bindings = figSession?.manifest?.bindings || [];
    groups.forEach((g: any) => {
      const binding = bindings.find((b: Binding) => b.groupId === g.groupId);
      if (binding && Array.isArray(binding.gids)) {
        // Group is visible if at least one GID is visible
        const isGroupVisible = binding.gids.some((gid: string) => {
          const obj = objects.find(o => o.id === gid);
          return obj ? obj.currentProps.visible !== false : false;
        });
        map[g.groupId] = isGroupVisible;
      }
    });

    return map;
  }, [figSession?.manifest?.objects, figSession?.manifest?.groups, figSession?.manifest?.bindings]);

  const handleToggleVisibility = (id: string) => {
    const objects = figSession?.manifest?.objects || [];
    const bindings = figSession?.manifest?.bindings || [];

    const isGroup = bindings.some((b: Binding) => b.groupId === id);
    if (isGroup) {
      const binding = bindings.find((b: Binding) => b.groupId === id);
      if (binding && Array.isArray(binding.gids) && onPatch) {
        const groupGids = binding.gids;
        const isAnyVisible = groupGids.some((gid: string) => {
          const obj = objects.find(o => o.id === gid);
          return obj ? obj.currentProps.visible !== false : false;
        });
        const nextValue = !isAnyVisible;
        const patches = groupGids.map((gid: string) => ({
          op: 'set' as const,
          mode: 'local_patch' as const,
          gid,
          prop: 'visible',
          value: nextValue
        }));
        onPatch(patches);
      }
    } else {
      const obj = objects.find(o => o.id === id);
      if (obj && onPatch) {
        const isCurrentlyVisible = obj.currentProps.visible !== false;
        onPatch([
          {
            op: 'set',
            mode: 'local_patch',
            gid: id,
            prop: 'visible',
            value: !isCurrentlyVisible,
          },
        ]);
      }
    }
  };

  const findSiblingsAndParent = (nodes: TreeNode[], targetId: string): { siblings: TreeNode[]; parentId: string } | null => {
    if (nodes.some(n => n.id === targetId)) {
      return { siblings: nodes, parentId: 'root' };
    }
    for (const node of nodes) {
      if (node.children) {
        if (node.children.some(c => c.id === targetId)) {
          return { siblings: node.children, parentId: node.id };
        }
        const found = findSiblingsAndParent(node.children, targetId);
        if (found) return found;
      }
    }
    return null;
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    if (!draggedId || draggedId === targetId) return;

    const res = findSiblingsAndParent(tree, targetId);
    if (!res) return;

    const { siblings } = res;
    const isDraggedInSiblings = siblings.some(n => n.id === draggedId);
    if (!isDraggedInSiblings) return;

    const newOrder = [...siblings];
    const draggedIndex = newOrder.findIndex(n => n.id === draggedId);
    const targetIndex = newOrder.findIndex(n => n.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return;

    const [draggedNode] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, draggedNode);

    const patches: PatchEntry[] = [];
    const N = newOrder.length;
    newOrder.forEach((node, index) => {
      const zValue = N - index;
      const gids: string[] = [];
      if (node.children && !node.id.endsWith('_Section')) {
        node.children.forEach(c => gids.push(c.id));
      } else {
        gids.push(node.id);
      }

      gids.forEach(gid => {
        patches.push({
          op: 'set',
          mode: 'backend_patch',
          gid,
          prop: 'zorder',
          value: zValue
        });
      });
    });

    if (patches.length > 0 && onPatch) {
      onPatch(patches);
    }
  };

  return (
    <div className="w-64 bg-slate-50 border-r border-slate-200 flex flex-col h-full shrink-0 hidden md:flex select-none">
      <div className="p-4 border-b border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-800 text-sm">项目资源</h2>
        </div>
        <ul className="space-y-1">
          {!projectId && (
            <li
              onClick={() => { setActiveFile('data.csv'); onSelectResourceFile?.('data.csv'); }}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm font-medium transition-colors ${activeFile === 'data.csv' ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-100 text-slate-700'}`}
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
              data.csv
            </li>
          )}
          <li
            onClick={() => { setActiveFile('figure_spec.json'); onSelectResourceFile?.('figure_spec.json'); }}
            className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm font-medium transition-colors ${activeFile === 'figure_spec.json' ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-100 text-slate-700'}`}
          >
            <FileJson className="w-4 h-4 text-blue-500" />
            figure_spec.json
          </li>
          <li
            onClick={() => { setActiveFile('render.py'); onSelectResourceFile?.('render.py'); }}
            className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm font-medium transition-colors ${activeFile === 'render.py' ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-100 text-slate-700'}`}
          >
            <FileCode className="w-4 h-4 text-amber-500" />
            render.py
          </li>
        </ul>

        {projectId && (
          <>
            <div className="flex items-center justify-between mb-2 mt-4 border-t border-slate-200 pt-3">
              <h2 className="font-semibold text-slate-400 text-xs uppercase tracking-wider">数据管理</h2>
              <label className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded cursor-pointer hover:bg-blue-100 transition-colors font-medium">
                上传
                <input
                  type="file"
                  accept=".csv,.tsv,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && onUploadFile) {
                      onUploadFile(file);
                    }
                  }}
                />
              </label>
            </div>
            <ul className="space-y-1 max-h-[140px] overflow-y-auto custom-scrollbar text-xs">
              {datasets && datasets.length > 0 ? (
                datasets.map(d => (
                  <li
                    key={d.datasetId}
                    className={`flex items-center justify-between px-2 py-1.5 rounded group hover:bg-slate-100 cursor-pointer ${activeFile === d.fileName ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600'}`}
                    onClick={() => { setActiveFile(d.fileName); onSelectResourceFile?.(d.fileName); }}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span className="truncate" title={d.fileName}>{d.fileName}</span>
                    </div>
                    {onDeleteFile && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`确定要删除数据集 "${d.fileName}" 吗？`)) {
                            onDeleteFile(d.datasetId);
                          }
                        }}
                        className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                        title="删除文件"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    )}
                  </li>
                ))
              ) : (
                <div className="text-[10px] text-slate-400 py-1 text-center">暂无数据文件</div>
              )}
            </ul>
          </>
        )}
      </div>

      <div className="p-4 flex-1 overflow-y-auto custom-scrollbar">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
            <Layout className="w-4 h-4 text-slate-500" />
            图层结构
          </h2>
        </div>
        <input
          type="text"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="搜索图层 / gid"
          className="mb-3 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-blue-500"
        />
        <div className="text-sm font-medium text-slate-700 space-y-0.5">
          {filteredTree.map(node => (
            <div key={node.id}>
              <TreeItem
                node={node}
                depth={0}
                expanded={expanded}
                visibleMap={visibleMap}
                selectedObject={selectedObject}
                onSelectObject={onSelectObject}
                selectedGids={selectedGids}
                onSelectGids={onSelectGids}
                allFlatNodes={flattenTree(filteredTree)}
                onToggleExpand={id => setExpanded(prev => ({ ...prev, [id]: !prev[id] }))}
                onToggleVisibility={handleToggleVisibility}
                lockedObjects={lockedObjects}
                onToggleLock={onToggleLock}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-auto border-t border-slate-200">
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-3 bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm">
            <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-500 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-800">Matplotlib</div>
              <div className="text-xs text-emerald-600">Parsed Successfully</div>
            </div>
          </div>
          <div className="flex items-center justify-center gap-2 bg-emerald-50 text-emerald-700 py-2 rounded-lg font-medium text-sm border border-emerald-100">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
            Publication Ready
          </div>
        </div>
      </div>
    </div>
  );
}
