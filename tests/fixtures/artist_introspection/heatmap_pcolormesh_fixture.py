import matplotlib.pyplot as plt
import numpy as np

def render():
    fig, ax = plt.subplots()
    data = np.random.rand(10, 12)
    ax.pcolormesh(data, cmap="plasma", vmin=0.2, vmax=0.8)
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
