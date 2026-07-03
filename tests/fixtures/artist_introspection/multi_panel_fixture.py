import matplotlib.pyplot as plt

def render():
    fig, (ax1, ax2) = plt.subplots(1, 2)
    ax1.plot([1, 2], [3, 4], label="p1")
    ax2.bar([1, 2], [2, 5], label="p2")
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
