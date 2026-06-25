import { FigureSpec } from '../types';

function escapePythonString(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function pythonBool(value: boolean) {
  return value ? 'True' : 'False';
}

const DFLT_FIGURE = { width: 85, height: 70, unit: 'mm' as const, dpi: 600 };
const DFLT_FONT = { family: 'Arial, sans-serif', title_size: 16, tick_size: 11, legend_size: 10 };
const DFLT_AXES = {
  spine_top: true, spine_bottom: true, spine_left: true, spine_right: true,
  spine_width: 0.5, tick_direction: 'out', x_tick_rotation: 0, title: '', xlabel: '', ylabel: ''
};
const DFLT_LEGEND = { show: false, location: 'best', frameon: false };

export function buildReproduciblePython(spec: FigureSpec) {
  const figure = spec.figure || DFLT_FIGURE;
  const font = spec.font || DFLT_FONT;
  const axes = spec.axes || DFLT_AXES;
  const legend = spec.legend || DFLT_LEGEND;
  const figW = (figure.width / 25.4).toFixed(4);
  const figH = (figure.height / 25.4).toFixed(4);
  const dpi = figure.dpi;

  if (spec.plot_type === 'custom') {
    const customScript = spec.custom_script?.trim() || '# 自定义脚本为空';
    const customData = JSON.stringify(spec.raw_data?.custom_data || [], null, 2);
    return [
      'import matplotlib.pyplot as plt',
      'import numpy as np',
      'import pandas as pd',
      '',
      '# Reproduced from SciFigure spec export',
      `_uploaded_data = ${customData}`,
      '',
      customScript,
      '',
      '# Spec-level overrides applied in SciFigure',
      'fig = plt.gcf()',
      `fig.set_size_inches(${figW}, ${figH}, forward=True)`,
      `fig.set_dpi(${dpi})`,
      'for ax in fig.axes:',
      axes.title ? `    ax.set_title("${escapePythonString(axes.title)}", fontsize=${font.title_size}, fontweight="bold")` : '    pass',
      axes.xlabel ? `    ax.set_xlabel("${escapePythonString(axes.xlabel)}", fontsize=${font.title_size})` : '',
      axes.ylabel ? `    ax.set_ylabel("${escapePythonString(axes.ylabel)}", fontsize=${font.title_size})` : '',
      `    ax.tick_params(labelsize=${font.tick_size}, width=${Number(axes.spine_width || 0)})`,
      '    visibility = {',
      `        "top": ${pythonBool(axes.spine_top !== false)},`,
      `        "bottom": ${pythonBool(axes.spine_bottom !== false)},`,
      `        "left": ${pythonBool(axes.spine_left !== false)},`,
      `        "right": ${pythonBool(axes.spine_right !== false)},`,
      '    }',
      '    for side, spine in ax.spines.items():',
      `        spine.set_linewidth(${Number(axes.spine_width || 0)})`,
      '        spine.set_visible(visibility.get(side, True))',
      legend.show
        ? `    ax.legend(loc="${escapePythonString(legend.location || 'best')}", frameon=${legend.frameon ? 'True' : 'False'}, fontsize=${font.legend_size})`
        : '    legend = ax.get_legend(); legend.remove() if legend else None',
      '',
      'plt.tight_layout()',
    ].filter(Boolean).join('\n');
  }

  if (spec.plot_type === 'ranked_response') {
    const items = spec.raw_data?.ranked_response?.items || [];
    const promotedColor = spec.colors.Promoted || '#1F78B4';
    const suppressedColor = spec.colors.Suppressed || '#D62728';

    return [
      'import matplotlib.pyplot as plt',
      'import numpy as np',
      'import pandas as pd',
      '',
      `items = ${JSON.stringify(items, null, 2)}`,
      'df = pd.DataFrame(items).sort_values("value", ascending=True).reset_index(drop=True)',
      'df["y"] = np.arange(len(df))',
      '',
      `fig, ax = plt.subplots(figsize=(${figW}, ${figH}), dpi=${dpi})`,
      `promoted_color = "${escapePythonString(promotedColor)}"`,
      `suppressed_color = "${escapePythonString(suppressedColor)}"`,
      '',
      'for _, row in df.iterrows():',
      '    color = promoted_color if row["value"] > 0 else suppressed_color',
      '    ax.hlines(row["y"], 0, row["value"], color=color, linewidth=1.9, zorder=2)',
      '    ax.scatter(row["value"], row["y"], s=34, color=color, edgecolor="white", linewidth=0.6, zorder=3)',
      '',
      'ax.axvline(0, color="#333333", linestyle=(0, (4, 3)), linewidth=1.0, zorder=1)',
      'ax.set_yticks(df["y"])',
      'ax.set_yticklabels(df["label"], fontsize=' + font.tick_size + ')',
      'ax.invert_yaxis()',
      '',
      axes.title ? `ax.set_title("${escapePythonString(axes.title)}", fontsize=${font.title_size}, fontweight="bold")` : '',
      axes.xlabel ? `ax.set_xlabel("${escapePythonString(axes.xlabel)}", fontsize=${font.title_size})` : '',
      axes.ylabel ? `ax.set_ylabel("${escapePythonString(axes.ylabel)}", fontsize=${font.title_size})` : '',
      `ax.tick_params(direction="${axes.tick_direction || 'out'}", labelsize=${font.tick_size}, width=${Number(axes.spine_width || 0)})`,
      `ax.spines["top"].set_visible(${pythonBool(axes.spine_top !== false)})`,
      `ax.spines["bottom"].set_visible(${pythonBool(axes.spine_bottom !== false)})`,
      `ax.spines["left"].set_visible(${pythonBool(axes.spine_left !== false)})`,
      `ax.spines["right"].set_visible(${pythonBool(axes.spine_right !== false)})`,
      `for spine in ax.spines.values(): spine.set_linewidth(${Number(axes.spine_width || 0)})`,
      legend.show
        ? [
          'legend_handles = [',
          `    plt.Line2D([0], [0], color=promoted_color, marker="o", markersize=6, linewidth=1.9, label="Promoted"),`,
          `    plt.Line2D([0], [0], color=suppressed_color, marker="o", markersize=6, linewidth=1.9, label="Suppressed"),`,
          ']',
          `ax.legend(handles=legend_handles, loc="${escapePythonString(legend.location || 'upper right')}", frameon=${legend.frameon ? 'True' : 'False'}, fontsize=${font.legend_size})`,
        ].join('\n')
        : '',
      '',
      'plt.tight_layout()',
    ].filter(Boolean).join('\n');
  }

  // bar / scatter_fit
  const isScatter = spec.plot_type === 'scatter_fit';
  const lines: string[] = [
    'import matplotlib.pyplot as plt',
    'import numpy as np',
  ];

  if (isScatter) {
    lines.push('from scipy import stats');
  }

  lines.push(
    '',
    `fig, ax = plt.subplots(figsize=(${figW}, ${figH}), dpi=${dpi})`,
    ''
  );

  if (isScatter) {
    Object.entries(spec.raw_data?.scatter || {}).forEach(([group, data]: [string, any]) => {
      const safeName = group.replace(/\W/g, '_') || 'group';
      lines.push(
        `x_${safeName} = np.array(${JSON.stringify(data.x || [])})`,
        `y_${safeName} = np.array(${JSON.stringify(data.y || [])})`,
        `ax.scatter(x_${safeName}, y_${safeName}, color="${escapePythonString(spec.colors[group] || '#000000')}", label="${escapePythonString(group)}")`,
        ''
      );
    });
  } else {
    const categories = spec.raw_data?.categories || [];
    const groups = Object.entries(spec.raw_data?.groups || {});

    lines.push(
      `labels = ${JSON.stringify(categories)}`,
      'x = np.arange(len(labels))',
      `width = ${(0.8 / Math.max(groups.length, 1)).toFixed(4)}`,
      ''
    );

    groups.forEach(([group, groupData]: [string, any], index: number) => {
      const safeName = group.replace(/\W/g, '_') || 'group';
      lines.push(`vals_${safeName} = np.array(${JSON.stringify(groupData.values || [])})`);
      if (groupData.errors) {
        lines.push(`errs_${safeName} = np.array(${JSON.stringify(groupData.errors)})`);
      }
      lines.push(
        `ax.bar(x + ${(index - (groups.length - 1) / 2).toFixed(4)} * width, vals_${safeName}, width, label="${escapePythonString(group)}", color="${escapePythonString(spec.colors[group] || '#000000')}"${groupData.errors ? `, yerr=errs_${safeName}, capsize=4` : ''})`,
        ''
      );
    });

    lines.push('ax.set_xticks(x)', `ax.set_xticklabels(labels, rotation=${axes.x_tick_rotation || 0})`);
  }

  if (axes.title) lines.push(`ax.set_title("${escapePythonString(axes.title)}", fontsize=${font.title_size}, fontweight="bold")`);
  if (axes.xlabel) lines.push(`ax.set_xlabel("${escapePythonString(axes.xlabel)}", fontsize=${font.title_size})`);
  if (axes.ylabel) lines.push(`ax.set_ylabel("${escapePythonString(axes.ylabel)}", fontsize=${font.title_size})`);
  lines.push(`ax.tick_params(direction="${axes.tick_direction || 'out'}", labelsize=${font.tick_size}, width=${Number(axes.spine_width || 0)})`);
  lines.push(`ax.spines["top"].set_visible(${pythonBool(axes.spine_top !== false)})`);
  lines.push(`ax.spines["bottom"].set_visible(${pythonBool(axes.spine_bottom !== false)})`);
  lines.push(`ax.spines["left"].set_visible(${pythonBool(axes.spine_left !== false)})`);
  lines.push(`ax.spines["right"].set_visible(${pythonBool(axes.spine_right !== false)})`);
  lines.push(`for spine in ax.spines.values(): spine.set_linewidth(${Number(axes.spine_width || 0)})`);

  if (legend.show) {
    lines.push(`ax.legend(loc="${escapePythonString(legend.location || 'best')}", frameon=${legend.frameon ? 'True' : 'False'}, fontsize=${font.legend_size})`);
  }

  lines.push('', 'plt.tight_layout()');
  return lines.join('\n');
}
