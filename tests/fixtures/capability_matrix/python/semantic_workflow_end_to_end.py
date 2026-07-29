import matplotlib.pyplot as plt
import numpy as np

fig, (ax, contour_ax) = plt.subplots(1, 2, figsize=(5.6, 3.6))
ax.fill_between(
    [0, 1, 2, 3],
    [0.7, 1.3, 1.2, 1.9],
    [1.1, 1.9, 2.1, 2.6],
    color="#8fb8de",
    alpha=0.4,
    linewidth=0.8,
    label="Confidence band",
)
ax.plot([0, 1, 2, 3], [1.0, 1.8, 1.4, 2.2], color="#1f77b4", linewidth=1.4, label="Series A")
ax.plot([0, 1, 2, 3], [0.8, 1.5, 2.0, 2.4], color="#d62728", linewidth=1.4, label="Series B")
ax.set_title("Semantic Workflow Regression")
ax.set_xlabel("Time")
ax.set_ylabel("Value")
ax.legend(loc="upper left")

grid = np.linspace(-1.5, 1.5, 24)
grid_x, grid_y = np.meshgrid(grid, grid)
surface = np.sin(grid_x) + np.cos(grid_y)
contour_ax.contourf(
    grid_x,
    grid_y,
    surface,
    levels=[-1.5, -0.75, 0.0, 0.75, 1.5],
    cmap="viridis",
    alpha=0.85,
)
contour_ax.set_title("Filled contour")
contour_ax.set_xlabel("X")
contour_ax.set_ylabel("Y")
plt.tight_layout()
