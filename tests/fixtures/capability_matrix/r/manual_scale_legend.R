library(ggplot2)

df <- data.frame(
  x = 1:6,
  y = c(1, 3, 2, 4, 3, 5),
  group = rep(c("Weak", "Mixed"), each = 3)
)
p <- ggplot(df, aes(x, y, color = group)) +
  geom_point(size = 3) +
  scale_color_manual(values = c(Weak = "#2C7FB8", Mixed = "#D95F0E"), name = "Response") +
  theme_classic()
p
