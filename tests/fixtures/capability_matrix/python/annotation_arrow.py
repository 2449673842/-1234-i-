import matplotlib.pyplot as plt

fig, ax = plt.subplots()
ax.plot([0, 1, 2], [0, 1, 0], label="response")
ax.annotate(
    "Peak",
    xy=(1, 1),
    xytext=(1.45, 1.35),
    arrowprops={"arrowstyle": "->", "color": "#444444"},
)
ax.legend()
