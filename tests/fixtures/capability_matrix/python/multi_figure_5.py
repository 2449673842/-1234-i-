import matplotlib.pyplot as plt

for index in range(5):
    fig, ax = plt.subplots()
    ax.plot([0, 1, 2], [index, index + 1, index + 0.5], label=f"series-{index + 1}")
    ax.set_title(f"Synthetic Figure {index + 1}")
    ax.legend()
