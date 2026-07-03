import matplotlib.pyplot as plt
import numpy as np

def render():
    fig, ax = plt.subplots()
    data = np.random.rand(10, 12)
    ax.imshow(data, cmap="viridis", vmin=0.1, vmax=0.9, interpolation="nearest")
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
