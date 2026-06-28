import matplotlib.pyplot as plt

def render():
    fig, ax = plt.subplots()
    x = ['A', 'B', 'C']
    y = [10, 20, 15]
    ax.bar(x, y, label="sales")
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
