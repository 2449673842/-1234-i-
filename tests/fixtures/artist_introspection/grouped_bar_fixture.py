import matplotlib.pyplot as plt
import numpy as np

def render():
    fig, ax = plt.subplots()
    categories = ['Category A', 'Category B', 'Category C']
    x = np.arange(len(categories))
    width = 0.35
    
    rects1 = ax.bar(x - width/2, [20, 35, 30], width, label='Group 1', color='#1f77b4')
    rects2 = ax.bar(x + width/2, [25, 32, 34], width, label='Group 2', color='#ff7f0e')
    
    ax.set_xticks(x)
    ax.set_xticklabels(categories)
    return fig

if __name__ == "__main__":
    fig = render()
    plt.show()
