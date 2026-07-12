import matplotlib.pyplot as plt
import numpy as np

fig, axes = plt.subplots(1, 2, figsize=(7, 3))
base = np.arange(16, dtype=float).reshape(4, 4)
for index, ax in enumerate(axes):
    image = ax.imshow(base + index, cmap="viridis")
    ax.set_title(f"Heatmap {index + 1}")
    fig.colorbar(image, ax=ax, label=f"Scale {index + 1}")
