const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const webConfig = {
  target: 'web',
  devtool: 'inline-source-map',
  devServer: {
    contentBase: './dist',
  },
  mode: "development",
  entry: './src/index.ts',
  plugins: [
    new HtmlWebpackPlugin({
      title: 'Map',
    }),
  ],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.json/,
        type: 'asset/resource'
      }
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
};

const dataConfig = {
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: "data/dataset", to: "dataset" },
      ],
    }),
  ],
};

const parserConfig = {
  target: 'node',
  entry: './src/trail_parser.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.json/,
        type: 'asset/resource'
      }
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: 'trail_parser.node.js',
    path: path.resolve(__dirname, 'dist'),
  },
}

const featurePrepConfig = {
  target: 'node',
  entry: './src/feature_divider.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.json/,
        type: 'asset/resource'
      }
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: 'feature_divider.node.js',
    path: path.resolve(__dirname, 'dist'),
  },
}

const testConfig = {
  target: 'node',
  entry: './src/util.test.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.json/,
        type: 'asset/resource'
      }
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: 'util.test.node.js',
    path: path.resolve(__dirname, 'dist'),
  },
}

module.exports = [webConfig, dataConfig, parserConfig, testConfig, featurePrepConfig];