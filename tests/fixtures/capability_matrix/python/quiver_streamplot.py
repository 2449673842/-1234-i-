import numpy as np
import matplotlib.pyplot as plt


grid = np.linspace(-2.0, 2.0, 7)
x, y = np.meshgrid(grid, grid)
u = -y
v = x

fig, (quiver_ax, stream_ax) = plt.subplots(1, 2, figsize=(7.2, 3.4))

quiver = quiver_ax.quiver(
    x,
    y,
    u,
    v,
    color="#4477aa",
    alpha=0.72,
    linewidth=1.1,
    label="Rotation vectors",
)
quiver_ax.set_title("Quiver field")
quiver_ax.set_xlabel("qx")
quiver_ax.set_ylabel("qy")
quiver_ax.legend(handles=[quiver])

stream = stream_ax.streamplot(
    x,
    y,
    u,
    v,
    color="#228833",
    density=0.65,
    linewidth=1.25,
    arrowsize=1.1,
)
stream.lines.set_label("Flow paths")
stream_ax.set_title("Streamplot field")
stream_ax.set_xlabel("sx")
stream_ax.set_ylabel("sy")
stream_ax.legend(handles=[stream.lines])

fig.tight_layout()
