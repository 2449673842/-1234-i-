import matplotlib.pyplot as plt
import numpy as np


grid = np.linspace(-1.5, 1.5, 24)
x_grid, y_grid = np.meshgrid(grid, grid)
surface = np.sin(x_grid) + np.cos(y_grid)

fig, (filled_ax, line_ax) = plt.subplots(1, 2, figsize=(6.4, 3.2))
filled = filled_ax.contourf(
    x_grid,
    y_grid,
    surface,
    levels=[-1.5, -0.75, 0.0, 0.75, 1.5],
    cmap="viridis",
    alpha=0.8,
)
fig.colorbar(filled, ax=filled_ax, label="Response")
line_ax.contour(
    x_grid,
    y_grid,
    surface,
    levels=[-1.0, 0.0, 1.0],
    cmap="magma",
    linewidths=1.2,
)
filled_ax.set_title("Filled contour")
line_ax.set_title("Contour lines")
