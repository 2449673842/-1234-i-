import matplotlib.pyplot as plt

def render():
    fig, ax = plt.subplots()
    ax.plot([1, 2, 3], [4, 5, 6], color="blue", linewidth=2.0, linestyle="-", marker="o", markersize=6.0, label="line1")
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
