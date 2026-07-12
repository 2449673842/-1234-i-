library(ggplot2)

df <- data.frame(x = 1:3, y = c(2, 4, 3), label = c("A", "B", "C"))
p <- ggplot(df, aes(x, y)) +
  geom_point(size = 3) +
  geom_text(aes(label = label), vjust = -0.5) +
  annotate("text", x = 2, y = 4.6, label = "Synthetic note") +
  theme_classic()
p
