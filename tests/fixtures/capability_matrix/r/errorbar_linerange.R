library(ggplot2)

df <- data.frame(
  group = c("A", "B", "C"),
  mean = c(2.2, 3.4, 2.9),
  low = c(1.7, 2.8, 2.3),
  high = c(2.8, 4.1, 3.6)
)
p <- ggplot(df, aes(group, mean)) +
  geom_point(size = 2.8, color = "#2C7FB8") +
  geom_errorbar(aes(ymin = low, ymax = high), width = 0.18, color = "#444444") +
  geom_linerange(aes(ymin = low + 0.1, ymax = high - 0.1), color = "#D95F0E") +
  theme_classic()
p
