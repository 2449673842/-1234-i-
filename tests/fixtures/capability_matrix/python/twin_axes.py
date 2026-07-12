import matplotlib.pyplot as plt

fig, left = plt.subplots()
right = left.twinx()
left.plot([0, 1, 2], [1, 2, 3], color="#1f77b4", label="left")
right.plot([0, 1, 2], [10, 18, 15], color="#d62728", label="right")
left.set_ylabel("Left scale")
right.set_ylabel("Right scale")
