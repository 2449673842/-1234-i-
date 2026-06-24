export interface SavedEditEntry {
  gid: string;
  prop: string;
  value: unknown;
  mode?: string;
  timestamp?: number;
}

export interface FigureSpec {
  plot_type: string;
  source?: {
    file_name?: string;
    file_type?: string;
    row_count?: number;
    column_count?: number;
    columns?: string[];
    imported_at?: string;
  };
  figure: {
    width: number;
    height: number;
    unit: string;
    dpi: number;
  };
  data: {
    x: string;
    y: string;
    group: string;
  };
  font: {
    family: string;
    title_size: number;
    tick_size: number;
    legend_size: number;
  };
  axes: {
    title: string;
    title_x?: number;
    title_y?: number;
    xlabel: string;
    ylabel: string;
    x_tick_rotation: number;
    tick_direction: 'in' | 'out' | 'inout';
    show_ticks: boolean;
    spine_width: number;
    spine_top?: boolean;
    spine_bottom?: boolean;
    spine_left?: boolean;
    spine_right?: boolean;
    linestyle?: string;
  };
  significance?: {
    style?: string;
    linewidth?: number;
  };
  colors: Record<string, string>;
  legend: {
    show: boolean;
    location: string;
    frameon: boolean;
    x?: number;
    y?: number;
  };
  raw_data?: {
    categories?: string[];
    groups?: Record<string, { values: number[]; errors?: number[] }>;
    scatter?: Record<string, { x: number[]; y: number[] }>;
    ranked_response?: {
      items: Array<{
        label: string;
        value: number;
        group: string;
      }>;
    };
    custom_data?: any[];
  };
  export: {
    format: string;
    dpi: number;
    color_mode?: string;
    embed_fonts?: boolean;
  };
  custom_script?: string;
  editLog?: SavedEditEntry[];
  script?: string;
}

export interface DatasetEntry {
  datasetId: string;
  fileName: string;
  filePath: string;
  columns: string[];
  rowCount: number;
  uploadedAt: string;
}

export interface FigureEntry {
  figureId: string;
  index: number;
  manifest: any;
  editLog: SavedEditEntry[];
  revision: number;
  svg?: string;
}

export interface SciFigureProject {
  projectId: string;
  name: string;
  script: string;
  datasets: DatasetEntry[];
  figures: FigureEntry[];
  createdAt: string;
  updatedAt: string;
}

export const defaultSpec: FigureSpec = {
  plot_type: 'bar',
  figure: { width: 85, height: 70, unit: 'mm', dpi: 600 },
  data: { x: 'site', y: 'abundance', group: 'period' },
  font: { family: 'Arial, sans-serif', title_size: 16, tick_size: 11, legend_size: 10 },
  axes: {
    title: 'Relative abundance of ARGs',
    xlabel: 'Sample',
    ylabel: 'Relative abundance (%)',
    x_tick_rotation: 0,
    tick_direction: 'out',
    show_ticks: true,
    spine_width: 1.0,
    spine_top: true,
    spine_bottom: true,
    spine_left: true,
    spine_right: true,
    linestyle: '实线 (Solid)',
  },
  colors: {
    EWR: '#1f77b4',
    NEWR: '#17becf',
  },
  legend: { show: true, location: 'upper right', frameon: false },
  raw_data: {
    categories: ['U1', 'U2', 'M1', 'M2', 'P1', 'P2'],
    groups: {
      EWR:  { values: [11.5, 21.8, 9.0, 15.9, 25.0, 11.0], errors: [1.0, 1.3, 0.8, 1.2, 1.4, 1.1] },
      NEWR: { values: [18.0, 29.8, 13.8, 20.0, 30.2, 14.1], errors: [1.2, 0.9, 0.9, 0.8, 0.6, 0.8] },
    },
    ranked_response: {
      items: [
        { label: 'S1', value: -0.72, group: 'Suppressed' },
        { label: 'S2', value: -0.21, group: 'Suppressed' },
        { label: 'S3', value: 0.36, group: 'Promoted' },
        { label: 'S4', value: 1.14, group: 'Promoted' },
      ],
    },
    scatter: {
      "Background FeP": {
        x: [400, 420, 410, 480, 500, 520, 510, 430, 490, 450],
        y: [-0.2, 0.1, -0.5, 1.2, 1.5, 2.1, 1.8, -0.1, 1.1, 0.5]
      },
      "FeP-enriched": {
        x: [410, 430, 420, 490, 510, 530, 520, 440, 500, 460],
        y: [-1.2, -0.8, -1.5, -0.2, 0.5, 1.1, 0.8, -1.1, 0.1, -0.5]
      }
    }
  },
  export: { format: 'PDF', dpi: 600 },
};
