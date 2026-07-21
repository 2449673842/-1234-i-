library(ggplot2)

df <- data.frame(x = c(1, 10, 100, 1000), y = c(2, 5, 20, 80), label = c("A", "B", "C", "D"))
p <- ggplot(df, aes(x, y)) +
  geom_point(size = 2.8, color = "#D95F0E") +
  geom_text(aes(label = label), vjust = -0.6) +
  scale_x_log10() +
  scale_y_log10() +
  theme_classic()
p
