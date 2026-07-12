library(ggplot2)

df <- data.frame(
  x = rep(1:4, 4),
  y = c(1:4, 2:5, 4:1, 5:2),
  panel = rep(c("A", "B", "C", "D"), each = 4)
)
p <- ggplot(df, aes(x, y, color = panel)) +
  geom_point(size = 2) +
  facet_wrap(~panel, nrow = 2) +
  theme_classic()
p
