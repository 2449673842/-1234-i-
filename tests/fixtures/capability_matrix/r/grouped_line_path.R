library(ggplot2)

df <- data.frame(
  time = rep(1:4, 2),
  value = c(1.0, 1.8, 2.4, 3.2, 1.4, 2.0, 2.9, 3.7),
  group = rep(c("Control", "Treatment"), each = 4)
)
p <- ggplot(df, aes(time, value, color = group, group = group)) +
  geom_line(linewidth = 0.9) +
  geom_path(linewidth = 0.35, linetype = "dashed") +
  geom_point(size = 2.2) +
  theme_classic()
p
