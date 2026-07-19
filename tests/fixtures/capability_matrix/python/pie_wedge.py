import matplotlib.pyplot as plt
from matplotlib.patches import Wedge


fig, ax = plt.subplots(figsize=(5, 4))
wedges, labels, values = ax.pie(
    [2, 3, 5],
    labels=["A", "B", "C"],
    colors=["#4477aa", "#cc6677", "#228833"],
    autopct="%1.0f%%",
    wedgeprops={"width": 0.35},
)
ax.legend(wedges, ["A", "B", "C"])
ax.add_patch(Wedge((2.0, 0.0), 0.4, 0, 120, facecolor="#aa3377", label="manual wedge"))
