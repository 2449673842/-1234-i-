library(ggplot2)

df <- data.frame(
  x = 1:6,
  y = c(1.2, 2.1, 2.8, 1.6, 2.7, 3.5),
  group = rep(c("Control", "Treatment"), each = 3)
)
p <- ggplot(df, aes(x, y, color = group)) +
  geom_point(size = 3) +
  theme_classic()
p
