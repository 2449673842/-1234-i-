import matplotlib.pyplot as plt

def render():
    fig, ax = plt.subplots()
    x = [1, 2, 3]
    y = [10, 20, 15]
    yerr = [1, 2, 1.5]
    ax.errorbar(x, y, yerr=yerr, fmt='o-', label="growth")
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
