import matplotlib.pyplot as plt
import numpy as np

def render():
    fig, ax = plt.subplots()
    # RGB image (3D array), typically has no cmap/clim
    data = np.zeros((8, 8, 3))
    data[2:6, 2:6, 0] = 1.0
    ax.imshow(data)
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
