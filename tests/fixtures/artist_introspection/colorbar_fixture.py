import matplotlib.pyplot as plt
import numpy as np

def render():
    fig, ax = plt.subplots()
    data = np.random.rand(10, 12)
    im = ax.imshow(data, cmap="inferno")
    fig.colorbar(im, ax=ax, orientation="vertical", label="Color intensity")
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
