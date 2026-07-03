import matplotlib.pyplot as plt

def render():
    fig, ax = plt.subplots()
    ax.bar([1, 2, 3], [5, 4, 3], color="#2ca02c", label="bars")
    ax.plot([1, 2, 3], [3, 5, 2], color="#d62728", marker="x", label="trend")
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
