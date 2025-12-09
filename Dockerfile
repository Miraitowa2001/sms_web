FROM node:18-alpine

WORKDIR /app

# 设置时区
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

# 创建数据目录
RUN mkdir -p data

EXPOSE 3000

CMD ["npm", "start"]
